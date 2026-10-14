(function bookingDeletionPermissionSettings(){
    const escape=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    document.addEventListener("DOMContentLoaded",async()=>{
        const notice=document.getElementById("deletionPermissionNotice"),list=document.getElementById("deletionPermissionMembers");
        if(!notice||!list)return;
        try{
            const context=await window.getAdminCompanyContext(),client=getSupabase(),user=(await client.auth.getUser()).data.user;
            const {data,error}=await client.rpc("booking_deletion_permission_members",{target_company_id:context.companyId});
            if(error)throw error;
            if(!data?.length){notice.textContent="Permission remains disabled. A verified company Owner or authorised platform administrator must grant it here.";return;}
            notice.textContent="No access is granted automatically. Toggle only the intended account; revocation is immediate.";
            list.innerHTML=data.map(member=>`<label class="permission-member"><input type="checkbox" data-user="${escape(member.user_id)}" ${member.allowed?"checked":""}> <span><strong>${escape(member.role)}${member.user_id===user?.id?" — You (current session)":""}</strong><small>Account ID: ${escape(member.user_id)}</small><small>${member.allowed?"Permanent deletion permitted":"Permanent deletion disabled"}</small></span></label>`).join("");
            list.querySelectorAll("[data-user]").forEach(input=>input.addEventListener("change",async event=>{
                const checkbox=event.currentTarget,desired=checkbox.checked;
                if(!confirm(desired?"Grant permanent booking deletion to this account? Eligible deletions will still require password reauthentication and exact confirmation.":"Revoke permanent booking deletion from this account immediately?")){checkbox.checked=!desired;return;}
                checkbox.disabled=true;
                const {error:saveError}=await client.rpc("set_booking_deletion_permission",{target_company_id:context.companyId,target_user_id:checkbox.dataset.user,allowed:desired});
                checkbox.disabled=false;
                if(saveError){checkbox.checked=!desired;notice.textContent=saveError.message;notice.classList.add("error");return;}
                notice.classList.remove("error");notice.textContent=desired?"Permanent deletion permission granted by the Owner.":"Permanent deletion permission revoked.";
            }));
        }catch(error){notice.textContent=error.message||"Permission settings are unavailable.";notice.classList.add("error");}
    });
})();
