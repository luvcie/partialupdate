import app_css from './app.css';
import app_html from './app.html';
import initialPrompt from './initialPrompt.md';

export function getPrompt(clientId: string, chatId: string): string {
	return initialPrompt
		.replaceAll('APP_CSS', app_css)
		.replaceAll('APP_HTML', app_html)
		.replaceAll('CLIENT_ID', clientId)
		.replaceAll('CHAT_ID', chatId);
}
