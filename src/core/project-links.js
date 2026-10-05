'use strict';

// Only these destinations may be opened by the renderer, never arbitrary URLs.
// Starshine Auto fork: the About links point at the fork's own repository.
const links = Object.freeze({
  github: 'https://github.com/STARSHINE56/DLSS5-Swapper',
  releases: 'https://github.com/STARSHINE56/DLSS5-Swapper/releases/latest'
});
function projectUrl(key) {
  return typeof key === 'string' && Object.hasOwn(links, key) ? links[key] : null;
}
module.exports = { links, projectUrl };
