// ===============================
// Supabase Connection
// ===============================

// These will eventually be loaded from the Settings page.
// For now you can paste your Project URL and Anon Key here.

const SUPABASE_URL = "https://fewbszrvmvjiojijogra.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZld2JzenJ2bXZqaW9qaWpvZ3JhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4Mjg0NTcsImV4cCI6MjA3NDQwNDQ1N30.dZJDqCthoHgGWSiUjRnmXRS0oFJ45_tp-_RzK9ebFd0";

let supabase = null;

// Initialise connection
function initSupabase() {

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.warn("Supabase has not been configured.");
        return null;
    }

    supabase = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_ANON_KEY
    );

    console.log("✅ Supabase Connected");

    return supabase;
}

// Return existing client
function getSupabase() {

    if (!supabase) {
        initSupabase();
    }

    return supabase;
}

// Test connection
async function testConnection() {

    const db = getSupabase();

    if (!db) return;

    const { error } = await db
        .from("companies")
        .select("*")
        .limit(1);

    if (error) {
        console.error("❌ Connection Failed:", error.message);
    } else {
        console.log("✅ Database Connected");
    }

}

// Automatically initialise
document.addEventListener("DOMContentLoaded", () => {
    initSupabase();
});