/** Replace characters that can alter or control terminal display. */
export function sanitizeTerminalText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

// C0/C1 controls, DEL, line/paragraph separators, and the bidirectional
// marks, embeddings, overrides, and isolates that can reorder what follows.
const TERMINAL_CONTROL =
	/[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
};

/**
 * Show terminal-controlling characters as backslash escapes instead of
 * blanking them like {@link sanitizeTerminalText}, so displayed data stays
 * recognisable. Joiners and other invisible format characters that shape
 * emoji and scripts are kept. Characters listed in `preserve` (such as the
 * tabs and newlines that structure TSV) pass through unchanged.
 */
export function escapeTerminalText(value: string, preserve = ""): string {
	return value.replace(TERMINAL_CONTROL, (character) => {
		if (preserve.includes(character)) {
			return character;
		}
		const named = NAMED_ESCAPES[character];
		if (named !== undefined) {
			return named;
		}
		const code = character.charCodeAt(0);
		return code <= 0xff
			? `\\x${code.toString(16).padStart(2, "0")}`
			: `\\u${code.toString(16).padStart(4, "0")}`;
	});
}
