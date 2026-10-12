package uk.co.transportplatform.gateway;
import android.content.*;
public final class ReceiptReceiver extends BroadcastReceiver {
 public void onReceive(Context c,Intent i){final int result=getResultCode();PendingResult pending=goAsync();new Thread(()->{try(Store store=new Store(c)){store.receipt(i.getStringExtra("scope"),i.getStringExtra("id"),i.getIntExtra("attempt",0),i.getStringExtra("kind"),i.getIntExtra("part",-1),result);}catch(Exception ignored){GatewayService.health(c,"Delivery receipt pending manual review.");}finally{pending.finish();}},"sms-receipt").start();}
}
