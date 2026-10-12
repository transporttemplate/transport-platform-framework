package uk.co.transportplatform.gateway;
import org.json.JSONObject;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class Api {
 static final String ENDPOINT="https://fewbszrvmvjiojijogra.supabase.co/functions/v1/sms-gateway";
 static final class Rejected extends IOException { final int status; Rejected(int s,String m){super(m);status=s;} }
 static JSONObject call(JSONObject body,String token) throws Exception {
  javax.net.ssl.HttpsURLConnection c=(javax.net.ssl.HttpsURLConnection)new URL(ENDPOINT).openConnection();
  c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(20000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");if(token!=null)c.setRequestProperty("x-gateway-token",token);
  try {byte[] b=body.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(b.length);try(OutputStream o=c.getOutputStream()){o.write(b);}int code=c.getResponseCode();InputStream in=code<400?c.getInputStream():c.getErrorStream();ByteArrayOutputStream out=new ByteArrayOutputStream();if(in!=null)try(InputStream stream=in){byte[] buf=new byte[4096];int n;while((n=stream.read(buf))!=-1){out.write(buf,0,n);if(out.size()>100000)throw new IOException("Oversized response");}}JSONObject result=new JSONObject(out.toString("UTF-8"));if(code<200||code>=300||!result.optBoolean("ok"))throw new Rejected(code,result.optString("error","Gateway rejected request"));return result;}finally{c.disconnect();}
 }
 static String hash(String s)throws Exception{StringBuilder b=new StringBuilder();for(byte v:MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)))b.append(String.format("%02x",v));return b.toString();}
}
