package uk.co.transportplatform.gateway;
import android.content.*;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import org.json.JSONObject;

public final class IncomingReceiver extends BroadcastReceiver {
 public void onReceive(Context c,Intent i){
  if(!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(i.getAction()))return;
  final PendingResult pending=goAsync();new Thread(()->{try{
   JSONObject auth=Vault.read(c);if(auth==null)return;
   int selected=c.getSharedPreferences("ui",0).getInt("sim",-1),incoming=i.getIntExtra("subscription",-1);
   // Fail closed on dual-SIM ambiguity: never import a personal SIM's SMS.
   if(selected<0||incoming!=selected)return;
   SmsMessage[] parts=Telephony.Sms.Intents.getMessagesFromIntent(i);if(parts==null||parts.length==0)return;
   String sender=parts[0].getOriginatingAddress();StringBuilder body=new StringBuilder();long stamp=parts[0].getTimestampMillis();
   for(SmsMessage part:parts){if(sender==null||!sender.equals(part.getOriginatingAddress()))return;body.append(part.getMessageBody());}
   if(body.length()==0||body.length()>4000)return;
   String key=Api.hash(sender+":"+stamp+":"+body);JSONObject data=new JSONObject().put("action","inbound").put("phone_e164",sender).put("body",body.toString()).put("idempotency_key",key);
   try(Store store=new Store(c)){store.queue(auth.getString("device_id"),"in:"+key,data);}
  }catch(Exception ignored){GatewayService.health(c,"Incoming SMS could not be stored; check handset storage and pairing.");}finally{pending.finish();}},"sms-inbound").start();
 }
}
