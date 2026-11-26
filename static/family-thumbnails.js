/* Only request the protected thumbnail JPEGs when the overview opens. */
(() => {
  const overview = document.getElementById('spread-overview');
  if (!overview) return;
  function loadThumbnails() {
    if (!overview.open) return;
    overview.querySelectorAll('img[data-src]').forEach((image) => {
      image.src = image.dataset.src;
      image.removeAttribute('data-src');
    });
  }
  overview.addEventListener('toggle', loadThumbnails);
  loadThumbnails();
})();
