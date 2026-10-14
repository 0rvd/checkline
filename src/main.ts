import { App } from './ui/app.js';

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');
new App(root);
