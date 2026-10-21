/* Loaded in <head> before first paint: applies the saved theme and sidebar state. */
(function () {
  'use strict';
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('att.theme');
    if (!theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    if (localStorage.getItem('att.nav') === 'collapsed') root.classList.add('nav-collapsed');
  } catch (e) { /* storage blocked: defaults apply */ }
})();
