import app_css from './app.css';
import app_html from './app.html';
import initialPrompt from './initialPrompt.md';

export function getPrompt(
	clientId: string,
	chatId: string,
	forkId: string,
): string {
	return initialPrompt
		.replaceAll('APP_CSS', app_css)
		.replaceAll('APP_HTML', app_html)
		.replaceAll('PpqUtcLGQdYN4oqc:FORK_ID', forkId);
}
