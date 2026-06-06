import app_css from './app.css';
import app_html from './app.html';
import initialPrompt from './initialPrompt.md';

const CLIENT_ID_TOKEN = 'PpqUtcLGQdYN4oqc:CLIENT_ID';
const CHAT_ID_TOKEN = 'PpqUtcLGQdYN4oqc:CHAT_ID';
const CLIENT_ID_SENTINEL = '__PARTIALUPDATE_CLIENT_ID_TOKEN__';
const CHAT_ID_SENTINEL = '__PARTIALUPDATE_CHAT_ID_TOKEN__';

export function getPrompt(clientId: string, chatId: string): string {
	return initialPrompt
		.replaceAll(CLIENT_ID_TOKEN, CLIENT_ID_SENTINEL)
		.replaceAll(CHAT_ID_TOKEN, CHAT_ID_SENTINEL)
		.replaceAll('APP_CSS', app_css)
		.replaceAll('APP_HTML', app_html)
		.replaceAll('CLIENT_ID', clientId)
		.replaceAll('CHAT_ID', chatId)
		.replaceAll(CLIENT_ID_SENTINEL, CLIENT_ID_TOKEN)
		.replaceAll(CHAT_ID_SENTINEL, CHAT_ID_TOKEN);
}
