package uk.co.transportplatform.gateway;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import android.provider.Settings;
import android.telephony.*;
import android.view.*;
import android.widget.*;
import java.util.*;
import org.json.*;

public final class MainActivity extends Activity {
 LinearLayout layout;TextView status;EditText company,pin;Spinner sim;List<SubscriptionInfo> sims=new ArrayList<>();Handler ui=new Handler();boolean dim;
 public void onCreate(Bundle b){super.onCreate(b);ScrollView scroll=new ScrollView(this);layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(28,50,28,36);scroll.addView(layout);setContentView(scroll);
  label("TRANSPORT · SMS GATEWAY",24);label("Dedicated business SIM only. Live sending stays disabled until physical testing and separate approval.",16);
  status=label("",16);company=input("Company code (4 digits)",false);pin=input("Pairing PIN (6–12 digits)",true);
  button("Pair company",()->pair());button("Grant SMS / phone permissions",()->permissions());sim=new Spinner(this);layout.addView(sim);button("Refresh SIM list",()->loadSims());
  button("Start gateway",()->{try{if(Vault.read(this)==null)throw new Exception("Pair first");if(sim.getSelectedItemPosition()<0||sims.isEmpty())throw new Exception("Grant permissions and select the dedicated SIM first");if(checkSelfPermission(android.Manifest.permission.SEND_SMS)!=PackageManager.PERMISSION_GRANTED||checkSelfPermission(android.Manifest.permission.RECEIVE_SMS)!=PackageManager.PERMISSION_GRANTED)throw new Exception("Grant SMS permissions first");getSharedPreferences("ui",0).edit().putInt("sim",sims.get(sim.getSelectedItemPosition()).getSubscriptionId()).apply();startForegroundService(new Intent(this,GatewayService.class));}catch(Exception e){show(e.getMessage());}});
  button("Stop gateway",()->{stopService(new Intent(this,GatewayService.class));getSharedPreferences("ui",0).edit().putBoolean("running",false).apply();show("Gateway stopped. Incoming messages are retained locally until restart.");});
  button("Dim Gateway Mode / restore",()->{dim=!dim;WindowManager.LayoutParams p=getWindow().getAttributes();p.screenBrightness=dim?0.01f:-1f;getWindow().setAttributes(p);if(dim)getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);});
  button("Battery / background settings",()->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,android.net.Uri.parse("package:"+getPackageName()))));
  button("Unpair and revoke",()->new AlertDialog.Builder(this).setMessage("Revoke this device? Requires a network connection. If offline, revoke it in Admin. Local queued data stays scoped to its original device/company.").setPositiveButton("Revoke",(d,w)->new Thread(()->{try{JSONObject a=Vault.read(this);if(a!=null)Api.call(new JSONObject().put("action","unpair"),a.getString("token"));stopService(new Intent(this,GatewayService.class));Vault.clear(this);show("Unpaired securely.");}catch(Exception e){show("Unable to revoke: "+e.getMessage());}}).start()).setNegativeButton("Cancel",null).show());
  label("Gateway notifications are silent; no device-wide audio or DND settings are changed. Keep the handset charged. Allow unrestricted battery operation manually. Android may stop a foreground service; reopen and start after reboot or force-stop. Never use a personal/shared SIM.",14);loadSims();ui.post(refresh);
 }
 TextView label(String text,int size){TextView v=new TextView(this);v.setText(text);v.setTextSize(size);v.setPadding(0,10,0,14);layout.addView(v);return v;}
 EditText input(String hint,boolean secret){EditText v=new EditText(this);v.setHint(hint);v.setSingleLine();v.setInputType(android.text.InputType.TYPE_CLASS_NUMBER|(secret?android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD:0));v.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);layout.addView(v);return v;}
 void button(String text,Runnable fn){Button b=new Button(this);b.setText(text);b.setAllCaps(false);b.setOnClickListener(v->fn.run());layout.addView(b);}
 void show(String text){runOnUiThread(()->{status.setText(text);Toast.makeText(this,text,Toast.LENGTH_LONG).show();});}
 void pair(){final String code=company.getText().toString().trim(),password=pin.getText().toString();if(!code.matches("[0-9]{4}")||!password.matches("[0-9]{6,12}")){show("Enter a four-digit company code and 6–12 digit PIN.");return;}new AlertDialog.Builder(this).setMessage("Pair this dedicated SIM with company "+code+"? Its incoming SMS will be visible to this company's Admin. A previous handset for that company will be revoked.").setPositiveButton("Pair",(d,w)->{pin.setText("");new Thread(()->{try{
   JSONObject old=Vault.read(this);if(old!=null)throw new Exception("Unpair the current company before re-pairing");
   android.content.SharedPreferences p=getSharedPreferences("ui",0);String fingerprint=p.getString("fingerprint",null);if(fingerprint==null){fingerprint=UUID.randomUUID().toString();p.edit().putString("fingerprint",fingerprint).commit();}
   JSONObject a=Api.call(new JSONObject().put("action","pair").put("company_code",code).put("pin",password).put("device_fingerprint",fingerprint).put("device_name",Build.MANUFACTURER+" "+Build.MODEL).put("apk_version","6.0.0"),null);Vault.save(this,a);show("Paired with "+a.getJSONObject("company").getString("name")+". Sending disabled.");
  }catch(Exception e){show(e.getMessage());}},"gateway-pair").start();}).setNegativeButton("Cancel",null).show();}
 void permissions(){ArrayList<String> p=new ArrayList<>(Arrays.asList(android.Manifest.permission.SEND_SMS,android.Manifest.permission.RECEIVE_SMS,android.Manifest.permission.READ_PHONE_STATE));if(Build.VERSION.SDK_INT>=33)p.add(android.Manifest.permission.POST_NOTIFICATIONS);requestPermissions(p.toArray(new String[0]),6);}
 void loadSims(){sims.clear();try{if(checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE)==PackageManager.PERMISSION_GRANTED){List<SubscriptionInfo> found=getSystemService(SubscriptionManager.class).getActiveSubscriptionInfoList();if(found!=null)sims.addAll(found);}}catch(SecurityException ignored){}List<String> names=new ArrayList<>();for(SubscriptionInfo s:sims)names.add("SIM "+(s.getSimSlotIndex()+1)+" · "+s.getCarrierName()+" · ID "+s.getSubscriptionId());sim.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,names));int selected=getSharedPreferences("ui",0).getInt("sim",-1);for(int n=0;n<sims.size();n++)if(sims.get(n).getSubscriptionId()==selected)sim.setSelection(n);}
 public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);loadSims();}
 Runnable refresh=new Runnable(){public void run(){android.content.SharedPreferences p=getSharedPreferences("ui",0);status.setText((p.getBoolean("running",false)?"Gateway running\n":"Gateway stopped\n")+p.getString("health","Pair and select a dedicated SIM to begin."));ui.postDelayed(this,10000);}};
 protected void onDestroy(){ui.removeCallbacks(refresh);super.onDestroy();}
}
