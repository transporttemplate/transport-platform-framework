package uk.co.transportplatform.gateway;
import android.content.*;
import android.database.*;
import android.database.sqlite.*;
import org.json.JSONObject;
import java.util.*;

final class Store extends SQLiteOpenHelper {
 Store(Context c){super(c,"gateway.db",null,1);setWriteAheadLoggingEnabled(true);}
 public void onCreate(SQLiteDatabase d){d.execSQL("CREATE TABLE outbox(k TEXT PRIMARY KEY,scope TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL)");d.execSQL("CREATE TABLE ledger(k TEXT PRIMARY KEY,scope TEXT NOT NULL,message TEXT NOT NULL,attempt INTEGER NOT NULL,parts INTEGER NOT NULL)");d.execSQL("CREATE TABLE receipts(k TEXT PRIMARY KEY,result INTEGER NOT NULL)");}
 public void onUpgrade(SQLiteDatabase d,int a,int b){throw new IllegalStateException("Explicit database migration required");}
 void queue(String scope,String key,JSONObject body){ContentValues v=new ContentValues();v.put("k",scope+":"+key);v.put("scope",scope);v.put("body",body.toString());v.put("created",System.currentTimeMillis());getWritableDatabase().insertWithOnConflict("outbox",null,v,SQLiteDatabase.CONFLICT_IGNORE);}
 List<String[]> pending(String scope){List<String[]> r=new ArrayList<>();try(Cursor c=getReadableDatabase().rawQuery("SELECT k,body FROM outbox WHERE scope=? ORDER BY created LIMIT 20",new String[]{scope})){while(c.moveToNext())r.add(new String[]{c.getString(0),c.getString(1)});}return r;}
 void ack(String key){getWritableDatabase().delete("outbox","k=?",new String[]{key});}
 boolean reserve(String scope,String id,int attempt,int parts){ContentValues v=new ContentValues();v.put("k",scope+":"+id);v.put("scope",scope);v.put("message",id);v.put("attempt",attempt);v.put("parts",parts);return getWritableDatabase().insertWithOnConflict("ledger",null,v,SQLiteDatabase.CONFLICT_IGNORE)!=-1;}
 synchronized void receipt(String scope,String id,int attempt,String type,int part,int result)throws Exception {
  SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{
   int count;try(Cursor c=db.rawQuery("SELECT parts FROM ledger WHERE k=? AND attempt=?",new String[]{scope+":"+id,String.valueOf(attempt)})){if(!c.moveToFirst())return;count=c.getInt(0);}
   if(part<0||part>=count)return;String prefix=scope+":"+id+":"+attempt+":"+type+":";
   ContentValues v=new ContentValues();v.put("k",prefix+part);v.put("result",result);db.insertWithOnConflict("receipts",null,v,SQLiteDatabase.CONFLICT_IGNORE);
   int all=0,good=0;for(int i=0;i<count;i++)try(Cursor c=db.rawQuery("SELECT result FROM receipts WHERE k=?",new String[]{prefix+i})){if(c.moveToFirst()){all++;if(c.getInt(0)==android.app.Activity.RESULT_OK)good++;}}
   if(all==count){String state=good==count?(type.equals("sent")?"sent":"delivered"):"uncertain";JSONObject b=new JSONObject().put("action","status").put("message_id",id).put("attempt",attempt).put("state",state);if(good!=count)b.put("error_code","MULTIPART_"+type.toUpperCase()+"_PARTIAL_OR_FAILED");queue(scope,id+":"+attempt+":"+type,b);}
   db.setTransactionSuccessful();
  }finally{db.endTransaction();}
 }
}
