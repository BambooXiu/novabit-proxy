// ==================== Guide Component ====================

window.App = window.App || {};

(function() {
  function init() {
    // FAQ 展开/收起
    const faqItems = document.querySelectorAll('.faq-item');
    faqItems.forEach(item => {
      const question = item.querySelector('.faq-question');
      if (question) {
        question.addEventListener('click', () => {
          item.classList.toggle('open');
        });
      }
    });
  }

  window.App.guide = { init };
})();
