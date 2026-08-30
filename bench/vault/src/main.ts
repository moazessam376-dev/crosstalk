import { startVault } from './boot.js';

const root = document.getElementById('root');
if (root !== null) {
  startVault(root);
}
