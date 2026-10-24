import { hydrate } from 'solid-js/web';
import DemoApp from './DemoApp';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root');

hydrate(() => <DemoApp />, root);
