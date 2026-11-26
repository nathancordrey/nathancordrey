import PhotoSwipeLightbox from './vendor/photoswipe/photoswipe-lightbox.esm.min.js';

// The page contains only authorized image URLs, with dimensions read server-side.
// No image data or token is sent to a third-party host.
const gallery = document.getElementById('album-gallery');
if (gallery && gallery.querySelector('a[data-pswp-width]')) {
  const lightbox = new PhotoSwipeLightbox({
    gallery: '#album-gallery',
    children: 'a[data-pswp-width]',
    pswpModule: () => import('./vendor/photoswipe/photoswipe.esm.min.js'),
    bgOpacity: 0.96,
    wheelToZoom: true,
    paddingFn: () => ({ top: 32, bottom: 32, left: 12, right: 12 }),
  });
  lightbox.init();
}
