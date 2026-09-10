// ==================== Notification Component ====================

window.App = window.App || {};

(function() {
  let notifyTimeout = null;

  function notify(message, type = 'info') {
    const el = document.getElementById('notification');
    const text = document.getElementById('notificationText');
    if (!el || !text) return;

    text.textContent = message;
    el.className = `notification show ${type}`;

    if (notifyTimeout) clearTimeout(notifyTimeout);
    notifyTimeout = setTimeout(() => {
      el.className = 'notification';
    }, 3000);
  }

  window.App.notify = notify;
})();
