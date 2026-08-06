// ==========================================
// Supabase Connection
// ==========================================

const SUPABASE_URL = "https://fewbszrvmvjiojijogra.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZld2JzenJ2bXZqaW9qaWpvZ3JhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4Mjg0NTcsImV4cCI6MjA3NDQwNDQ1N30.dZJDqCthoHgGWSiUjRnmXRS0oFJ45_tp-_RzK9ebFd0";

let supabaseClient = null;

// Initialise connection
function initSupabase() {

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.warn("Supabase has not been configured.");
        return null;
    }

    supabaseClient = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_ANON_KEY
    );

    console.log("✅ Supabase Connected");

    return supabaseClient;
}

// Return existing client
function getSupabase() {

    if (!supabaseClient) {
        initSupabase();
    }

    return supabaseClient;
}

document.addEventListener("DOMContentLoaded", async () => {
    initSupabase();
   
});

window.initSupabase = initSupabase;
window.getSupabase = getSupabase;