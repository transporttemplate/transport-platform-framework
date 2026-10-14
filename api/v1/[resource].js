const EDGE="https://fewbszrvmvjiojijogra.supabase.co/functions/v1/api-v1/v1/";
module.exports=async function handler(request,response){
 const resource=String(request.query.resource||"");if(!["bookings","availability","vehicles"].includes(resource))return response.status(404).json({ok:false,error:"Unsupported API v1 endpoint"});
 const headers={"content-type":"application/json"};for(const name of ["x-api-key","idempotency-key","x-request-id"])if(request.headers[name])headers[name]=request.headers[name];
 const upstream=await fetch(EDGE+resource,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:JSON.stringify(request.body||{})});
 response.status(upstream.status);for(const name of ["content-type","x-request-id"])if(upstream.headers.get(name))response.setHeader(name,upstream.headers.get(name));return response.send(await upstream.text());
};
