package uk.co.transportplatform.gateway;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.*;
import android.os.*;
import android.telephony.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

public final class GatewayService extends Service {
 static final String CHANNEL="gateway_silent";
 private ScheduledExecutorService worker; private volatile boolean stopped; private boolean started; private int failures;
 public android.os.IBinder onBind(Intent i){return null;}
 static void health(Context c,String s){c.getSharedPreferences("ui",0).edit().putString("health",s).putLong("checked",System.currentTimeMillis()).apply();}
 public void onCreate(){super.onCreate();NotificationChannel ch=new NotificationChannel(CHANNEL,"Gateway status (silent)",NotificationManager.IMPORTANCE_LOW);ch.setSound(null,null);ch.enableVibration(false);getSystemService(NotificationManager.class).createNotificationChannel(ch);worker=Executors.newSingleThreadScheduledExecutor();}
 public int onStartCommand(Intent i,int flags,int startId){
  if(i!=null&&"STOP".equals(i.getAction())){stopSelf();return START_NOT_STICKY;}
  PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE);
  PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,GatewayService.class).setAction("STOP"),PendingIntent.FLAG_IMMUTABLE);
  Notification n=new Notification.Builder(this,CHANNEL).setContentTitle("Transport SMS Gateway").setContentText("Company gateway running · tap to view · stop any time").setSmallIcon(android.R.drawable.stat_notify_chat).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).addAction(new Notification.Action.Builder(null,"Stop",stop).build()).build();
  startForeground(6,n);if(!started){started=true;getSharedPreferences("ui",0).edit().putBoolean("running",true).apply();worker.execute(this::cycle);}return START_NOT_STICKY;
 }
 private void cycle(){if(stopped)return;try{
  JSONObject auth=Vault.read(this);if(auth==null){health(this,"Pair this device first.");stopSelf();return;}
  String token=auth.getString("token"),scope=auth.getString("device_id");int sim=getSharedPreferences("ui",0).getInt("sim",-1);
  boolean send=checkSelfPermission(android.Manifest.permission.SEND_SMS)==PackageManager.PERMISSION_GRANTED,receive=checkSelfPermission(android.Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED;
  TelephonyManager tm=getSystemService(TelephonyManager.class);ConnectivityManager cm=getSystemService(ConnectivityManager.class);
  JSONObject heartbeat=Api.call(new JSONObject().put("action","heartbeat").put("apk_version","6.0.0").put("send_sms",send).put("receive_sms",receive).put("sim_status",sim>=0?"Selected SIM "+sim+"; state "+tm.getSimState():"No selected SIM").put("network_status",cm.getActiveNetwork()!=null?"Connected":"Offline"),token);
  try(Store store=new Store(this)){
   for(String[] q:store.pending(scope)){try{Api.call(new JSONObject(q[1]),token);store.ack(q[0]);}catch(Api.Rejected e){if(e.status==401||e.status==403)throw e;health(this,"Queued item rejected; retained for review. "+e.getMessage());break;}}
   if(heartbeat.optBoolean("sending_enabled")&&send&&receive&&validSim(sim)){
    JSONObject claim=Api.call(new JSONObject().put("action","claim"),token);JSONArray messages=claim.optJSONArray("messages");
    if(claim.optBoolean("sending_enabled")&&messages!=null&&messages.length()>0)transmit(store,auth,sim,messages.getJSONObject(0));
   }
  }
  failures=0;health(this,heartbeat.optBoolean("sending_enabled")?"Online · authorised queue active":"Online · live SMS sending DISABLED");
 }catch(Api.Rejected e){if(e.status==401||e.status==403){health(this,"Pairing revoked / company unavailable. Re-pair in Admin.");stopSelf();return;}failures++;health(this,e.getMessage());}
 catch(Exception e){failures++;health(this,"Offline / retrying safely. No uncertain message will be resent.");}
 if(!stopped)worker.schedule(this::cycle,Math.min(300,30L*(1L<<Math.min(failures,3))),TimeUnit.SECONDS);
 }
 private boolean validSim(int id){try{if(checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE)!=PackageManager.PERMISSION_GRANTED)return false;List<SubscriptionInfo> sims=getSystemService(SubscriptionManager.class).getActiveSubscriptionInfoList();if(sims!=null)for(SubscriptionInfo s:sims)if(s.getSubscriptionId()==id)return true;}catch(SecurityException ignored){}return false;}
 private void transmit(Store store,JSONObject auth,int sim,JSONObject m)throws Exception {
  String scope=auth.getString("device_id"),id=m.getString("id");int attempt=m.getInt("attempt");SmsManager manager=SmsManager.getSmsManagerForSubscriptionId(sim);ArrayList<String> parts=manager.divideMessage(m.getString("body"));
  // Commit local reservation BEFORE prepare. Any crash/network uncertainty
  // deliberately sacrifices delivery rather than risk sending twice.
  if(!store.reserve(scope,id,attempt,parts.size()))return;
  JSONObject receipt=new JSONObject().put("action","status").put("message_id",id).put("attempt",attempt).put("state","uncertain").put("error_code","PREPARE_OR_TRANSMIT_UNCERTAIN");
  try{
   JSONObject permit=Api.call(new JSONObject().put("action","prepare").put("message_id",id).put("attempt",attempt),auth.getString("token"));if(!permit.optBoolean("may_send"))return;
   ArrayList<PendingIntent> sent=new ArrayList<>(),delivered=new ArrayList<>();for(int p=0;p<parts.size();p++){sent.add(callback(scope,id,attempt,"sent",p));delivered.add(callback(scope,id,attempt,"delivered",p));}
   manager.sendMultipartTextMessage(m.getString("phone_e164"),null,parts,sent,delivered);
  }catch(Exception e){store.queue(scope,"uncertain:"+id+":"+attempt,receipt);throw e;}
 }
 private PendingIntent callback(String scope,String id,int attempt,String kind,int part){Intent i=new Intent(this,ReceiptReceiver.class).setData(Uri.parse("gateway://receipt/"+scope+"/"+id+"/"+attempt+"/"+kind+"/"+part)).putExtra("scope",scope).putExtra("id",id).putExtra("attempt",attempt).putExtra("kind",kind).putExtra("part",part);return PendingIntent.getBroadcast(this,0,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
 public void onDestroy(){stopped=true;getSharedPreferences("ui",0).edit().putBoolean("running",false).apply();if(worker!=null)worker.shutdownNow();super.onDestroy();}
}
