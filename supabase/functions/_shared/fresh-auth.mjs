export function passwordAuthenticationTime(token,userId){
  try{
    const part=String(token||'').split('.')[1];
    if(!part)return 0;
    const base64=part.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(part.length/4)*4,'=');
    const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0));
    const claims=JSON.parse(new TextDecoder().decode(bytes));
    if(claims.sub!==userId||!Array.isArray(claims.amr))return 0;
    return claims.amr
      .filter(entry=>entry?.method==='password'&&Number.isFinite(Number(entry.timestamp)))
      .reduce((latest,entry)=>Math.max(latest,Number(entry.timestamp)),0);
  }catch{return 0}
}

export function hasFreshPasswordAuthentication(token,userId,nowSeconds=Math.floor(Date.now()/1000),maximumAgeSeconds=900){
  const authenticatedAt=passwordAuthenticationTime(token,userId),age=nowSeconds-authenticatedAt;
  return authenticatedAt>0&&age>=0&&age<=maximumAgeSeconds;
}
