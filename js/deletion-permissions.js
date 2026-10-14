(function bookingDeletionPermissionSettings(){
 const escape=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
 const when=value=>value?new Date(value).toLocaleString("en-GB"):"Never";
 document.addEventListener("DOMContentLoaded",async()=>{
  const notice=document.getElementById("deletionPermissionNotice"),list=document.getElementById("deletionPermissionMembers"),history=document.getElementById("deletionPermissionHistory"),picker=document.getElementById("deletionPermissionCompany");
  if(!notice||!list||!history||!picker)return;
  const client=getSupabase(),context=await window.getAdminCompanyContext(),user=(await client.auth.getUser()).data.user;
  const companiesResult=await client.rpc("booking_deletion_management_companies");
  if(companiesResult.error||!companiesResult.data?.length){picker.hidden=true;notice.textContent="Permission remains disabled. A verified company Owner for this company or an authorised platform administrator must manage it here.";notice.classList.add("error");return;}
  picker.innerHTML=companiesResult.data.map(c=>`<option value="${escape(c.company_id)}">${escape(c.company_code)} — ${escape(c.company_name)} (${escape(c.authority.replace("_"," "))})</option>`).join("");
  const preferred=companiesResult.data.find(c=>c.company_id===context.companyId);if(preferred)picker.value=preferred.company_id;
  picker.onchange=load;await load();
  async function load(){
   const companyId=picker.value;notice.classList.remove("error");notice.textContent="Loading company-scoped permissions…";
   const [membersResult,historyResult]=await Promise.all([client.rpc("booking_deletion_permission_members",{target_company_id:companyId}),client.rpc("booking_deletion_permission_history",{target_company_id:companyId})]);
   if(membersResult.error||historyResult.error){notice.textContent=(membersResult.error||historyResult.error).message;notice.classList.add("error");list.innerHTML="";history.innerHTML="";return;}
   notice.textContent="No access is granted automatically. Toggle only the intended account; revocation is immediate.";
   list.innerHTML=(membersResult.data||[]).map(member=>`<label class="permission-member"><input type="checkbox" data-user="${escape(member.user_id)}" ${member.allowed?"checked":""}> <span><strong>${escape(member.role)}${member.user_id===user?.id?" — You (current session)":""}</strong><small>Account ID: ${escape(member.user_id)}</small><small>${member.allowed?"Permanent deletion permitted":"Permanent deletion disabled"} · Last change: ${escape(when(member.last_changed_at))}</small></span></label>`).join("")||"No eligible Admin or Owner memberships exist for this company.";
   history.innerHTML=(historyResult.data||[]).map(item=>`<div class="history-row"><span>${escape(when(item.created_at))}</span><span>${escape(item.target_user_id)}</span><span>${item.next_allowed?"Granted":"Revoked"}</span><span>${escape(item.actor_authority)}</span></div>`).join("")||"No permission changes have been recorded.";
   list.querySelectorAll("[data-user]").forEach(input=>input.addEventListener("change",change));
  }
  async function change(event){const checkbox=event.currentTarget,desired=checkbox.checked;if(!confirm(desired?"Grant permanent booking deletion to this account? Eligible deletions still require password reauthentication and exact confirmation.":"Revoke permanent booking deletion from this account immediately?")){checkbox.checked=!desired;return}checkbox.disabled=true;const {error}=await client.rpc("set_booking_deletion_permission",{target_company_id:picker.value,target_user_id:checkbox.dataset.user,allowed:desired});checkbox.disabled=false;if(error){checkbox.checked=!desired;notice.textContent=error.message;notice.classList.add("error");return}await load()}
 });
})();
