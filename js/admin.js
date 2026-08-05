document.addEventListener("DOMContentLoaded", () => {

    const menuButton = document.querySelector(".menu-toggle");
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.querySelector(".overlay");

    if (!menuButton || !sidebar || !overlay) return;

    menuButton.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        overlay.classList.toggle("show");
    });

    overlay.addEventListener("click", () => {
        sidebar.classList.remove("open");
        overlay.classList.remove("show");
    });

    window.addEventListener("resize", () => {
        if (window.innerWidth > 900) {
            sidebar.classList.remove("open");
            overlay.classList.remove("show");
        }
    });

});