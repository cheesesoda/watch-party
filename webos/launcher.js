// The webOS app is a small launcher: it remembers the server address, checks the server is up,
// then opens the server's own web client, which does everything else.
(function () {
  var KEY = "wp_server";
  var connecting = document.getElementById("connecting");
  var connectingText = document.getElementById("connecting-text");
  var setup = document.getElementById("setup");
  var input = document.getElementById("server");
  var error = document.getElementById("error");
  var timer = null;

  function load() {
    try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
  }

  function save(url) {
    try { localStorage.setItem(KEY, url); } catch (e) {}
  }

  // "192.168.1.20:8080/" or a pasted invite link -> "http://192.168.1.20:8080"
  function normalize(raw) {
    var s = raw.trim().replace(/#.*$/, "").replace(/\/+$/, "");
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    return s;
  }

  function showSetup(message) {
    clearTimeout(timer);
    connecting.hidden = true;
    setup.hidden = false;
    input.value = load();
    error.hidden = !message;
    error.textContent = message || "";
    input.focus();
  }

  function check(url, done) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url + "/api/health");
    xhr.timeout = 6000;
    xhr.onload = function () { done(xhr.status === 200); };
    xhr.onerror = xhr.ontimeout = function () { done(false); };
    xhr.send();
  }

  function connect(url) {
    setup.hidden = true;
    connecting.hidden = false;
    connectingText.textContent = "Connecting to " + url + "…";
    document.getElementById("change").focus();
    check(url, function (ok) {
      if (connecting.hidden) return; // switched to setup meanwhile
      if (!ok) return showSetup("Couldn't reach " + url + ". Check the address and that the server is running.");
      // Give a moment to press Change server, then hand over to the web client.
      timer = setTimeout(function () { location.replace(url + "/"); }, 1200);
    });
  }

  document.getElementById("change").addEventListener("click", function () { showSetup(""); });
  setup.addEventListener("submit", function (e) {
    e.preventDefault();
    var url = normalize(input.value);
    if (!url) return showSetup("Enter the server address.");
    save(url);
    connect(url);
  });

  var saved = load();
  if (saved) connect(saved);
  else showSetup("");
})();
