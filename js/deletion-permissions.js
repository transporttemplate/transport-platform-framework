(function bookingDeletionPermissionSettings(){
    const escape=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    document.addEventListener("DOMContentLoaded",async()=>{
        const notice=document.getElementById("deletionPermissionNotice"),list=document.getElementById("deletionPermissionMembers");
        if(!notice||!list)return;
        try{
            const context=await window.getAdminCompanyContext(),client=getSupabase();
            const {data,error}=await client.rpc("booking_deletion_permission_members",{target_company_id:context.companyId});
            if(error)throw error;
            if(!data?.length){notice.textContent="Only a company Owner can view or change this permission.";return;}
            notice.textContent="No access is granted automatically. Changes take effect only after an Owner saves them here.";
            list.innerHTML=data.map(member=>`<label class="permission-member"><input type="checkbox" data-user="${escape(member.user_id)}" ${member.allowed?"checked":""}> <span><strong>${escape(member.role)}</strong><small>${escape(member.user_id)}</small></span></label>`).join("");
            list.querySelectorAll("[data-user]").forEach(input=>input.addEventListener("change",async event=>{
                const checkbox=event.currentTarget,desired=checkbox.checked;checkbox.disabled=true;
                const {error:saveError}=await client.rpc("set_booking_deletion_permission",{target_company_id:context.companyId,target_user_id:checkbox.dataset.user,allowed:desired});
                checkbox.disabled=false;
                if(saveError){checkbox.checked=!desired;notice.textContent=saveError.message;notice.classList.add("error");return;}
                notice.classList.remove("error");notice.textContent=desired?"Permanent deletion permission granted by the Owner.":"Permanent deletion permission revoked.";
            }));
        }catch(error){notice.textContent=error.message||"Permission settings are unavailable.";notice.classList.add("error");}
    });
})();
