const db = getSupabase();

function camelToSnake(str) {
    return str.replace(/[A-Z]/g, letter => "_" + letter.toLowerCase());
}

function snakeToCamel(str) {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

document.addEventListener("DOMContentLoaded", () => {

    loadSettings();

    const saveButton = document.getElementById("saveSettings");

    if (saveButton) {
        saveButton.addEventListener("click", saveSettings);
    }

});

async function loadSettings() {

    try {

        const { data, error } = await db
            .from("settings")
            .select("*")
            .limit(1)
            .single();

        if (error) {

            console.log("No settings found. Defaults will be used.");
            return;

        }

        if (!data) return;

        populateForm(data);

    } catch (err) {

        console.error(err);

    }

}

function populateForm(data) {

    Object.keys(data).forEach((dbKey) => {

        const htmlId = snakeToCamel(dbKey);

        const element = document.getElementById(htmlId) ||
                        document.getElementById(dbKey);

        if (!element) return;

        if (element.type === "checkbox") {

            element.checked = !!data[dbKey];

        } else {

            element.value = data[dbKey] ?? "";

        }

    });

}

async function saveSettings() {

    try {

        const settings = {};

        document.querySelectorAll("input, select, textarea").forEach((element) => {

            if (!element.id) return;

            const dbKey = camelToSnake(element.id);

            if (element.type === "checkbox") {

                settings[dbKey] = element.checked;

            } else {

                settings[dbKey] = element.value;

            }

        });

        const { data: existing } = await db
            .from("settings")
            .select("id")
            .limit(1)
            .single();

        if (existing) {

            const { error } = await db
                .from("settings")
                .update(settings)
                .eq("id", existing.id);

            if (error) throw error;

        } else {

            const { error } = await db
                .from("settings")
                .insert(settings);

            if (error) throw error;

        }

        alert("Settings saved successfully.");

    } catch (err) {

        console.error(err);

        alert("Unable to save settings.");

    }

}