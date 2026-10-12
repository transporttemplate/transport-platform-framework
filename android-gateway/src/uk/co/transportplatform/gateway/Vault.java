package uk.co.transportplatform.gateway;
import android.content.*;
import android.security.keystore.*;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class Vault {
 static final String ALIAS="transport.sms.gateway.v6";
 static synchronized javax.crypto.SecretKey key() throws Exception {
  KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
  if(!ks.containsAlias(ALIAS)){KeyGenerator g=KeyGenerator.getInstance("AES","AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();}
  return (javax.crypto.SecretKey)ks.getKey(ALIAS,null);
 }
 static synchronized void save(Context c,JSONObject data) throws Exception {
  Cipher x=Cipher.getInstance("AES/GCM/NoPadding");x.init(Cipher.ENCRYPT_MODE,key());
  c.getSharedPreferences("vault",0).edit().putString("iv",Base64.encodeToString(x.getIV(),Base64.NO_WRAP)).putString("data",Base64.encodeToString(x.doFinal(data.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)),Base64.NO_WRAP)).commit();
 }
 static synchronized JSONObject read(Context c) throws Exception {
  android.content.SharedPreferences p=c.getSharedPreferences("vault",0);if(!p.contains("data"))return null;
  Cipher x=Cipher.getInstance("AES/GCM/NoPadding");x.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p.getString("iv",""),Base64.NO_WRAP)));
  return new JSONObject(new String(x.doFinal(Base64.decode(p.getString("data",""),Base64.NO_WRAP)),java.nio.charset.StandardCharsets.UTF_8));
 }
 static void clear(Context c){c.getSharedPreferences("vault",0).edit().clear().commit();}
}
