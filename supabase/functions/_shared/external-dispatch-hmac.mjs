export async function sha256Body(value=new Uint8Array()){
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',value))]
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function dispatchApiPath(value){
  const url=value instanceof URL?value:new URL(String(value));
  const parts=url.pathname.split('/').filter(Boolean),v1=parts.lastIndexOf('v1');
  return '/'+(v1>=0?parts.slice(v1):parts).join('/');
}

export function dispatchCanonical(timestamp,nonce,method,path,bodyHash){
  return `${timestamp}\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash}`;
}
