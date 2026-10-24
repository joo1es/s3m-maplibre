import { hydrate } from 'solid-js/web';
import DocApp from './app';
import type { PageData } from './lib/types';
import './styles/doc.css';

const dataNode = document.getElementById('s3m-page-data');
if (!dataNode?.textContent) throw new Error('缺少 s3m-page-data，页面不是由 SSG 生成的');

const page = JSON.parse(dataNode.textContent) as PageData;
const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root');

hydrate(() => <DocApp page={page} />, root);

