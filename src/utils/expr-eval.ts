/**
 * Safe expression evaluator — no eval() or new Function() used.
 *
 * Supports: arithmetic (+,-,*,/,%), comparison (===,!==,==,!=,<,>,<=,>=),
 * logical (&&,||,??), unary (!,-), ternary (?:), parentheses, string/number/
 * boolean/null/undefined literals, and identifier lookup from a context object.
 *
 * Does NOT support: method calls, property/index access, assignment, or control flow.
 */

export type ExprValue = string | number | boolean | null;

/** Evaluate an expression with the given variable context. Returns null on error. */
export function evalExpr(expr: string, ctx: Record<string, unknown>): ExprValue {
	try {
		return new ExprParser(expr.trim(), ctx).parse();
	} catch {
		return null;
	}
}

/** Validate expression syntax. Returns null if valid, or an error message. */
export function checkExprSyntax(expr: string): string | null {
	try {
		new ExprParser(expr.trim(), {}).parse();
		return null;
	} catch (e) {
		return (e as Error).message;
	}
}

class ExprParser {
	private pos = 0;

	constructor(
		private readonly src: string,
		private readonly ctx: Record<string, unknown>,
	) {}

	parse(): ExprValue {
		if (!this.src) return null;
		const v = this.parseTernary();
		this.ws();
		if (this.pos < this.src.length) throw new Error(`Unexpected: "${this.src[this.pos]}"`);
		if (v == null) return null;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
		return null;
	}

	private ws(): void {
		while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
	}

	private peek(offset = 0): string {
		return this.src[this.pos + offset] ?? "";
	}

	private eat(): string {
		return this.src[this.pos++] ?? "";
	}

	private match(s: string): boolean {
		if (this.src.startsWith(s, this.pos)) {
			this.pos += s.length;
			return true;
		}
		return false;
	}

	private parseTernary(): unknown {
		const cond = this.parseOr();
		this.ws();
		// '?' starts ternary only when not '??' (nullish coalescing) or '?.' (optional chain)
		if (this.peek() === "?" && this.peek(1) !== "?" && this.peek(1) !== ".") {
			this.pos++;
			const then = this.parseTernary();
			this.ws();
			if (!this.match(":")) throw new Error("Expected ':'");
			const els = this.parseTernary();
			return cond ? then : els;
		}
		return cond;
	}

	private parseOr(): unknown {
		let left = this.parseAnd();
		this.ws();
		while (true) {
			if (this.match("??")) { const r = this.parseAnd(); left = left ?? r; }
			else if (this.match("||")) { const r = this.parseAnd(); left = left || r; }
			else break;
			this.ws();
		}
		return left;
	}

	private parseAnd(): unknown {
		let left = this.parseEquality();
		this.ws();
		while (this.match("&&")) {
			const r = this.parseEquality();
			left = left && r;
			this.ws();
		}
		return left;
	}

	private parseEquality(): unknown {
		let left = this.parseRelational();
		this.ws();
		while (true) {
			if (this.match("===")) { const r = this.parseRelational(); left = left === r; }
			else if (this.match("!==")) { const r = this.parseRelational(); left = left !== r; }
			else if (this.match("==")) { const r = this.parseRelational(); left = left == r; } // eslint-disable-line eqeqeq -- intentionally implements JS loose equality semantics for the == operator
			else if (this.match("!=")) { const r = this.parseRelational(); left = left != r; } // eslint-disable-line eqeqeq -- intentionally implements JS loose equality semantics for the != operator
			else break;
			this.ws();
		}
		return left;
	}

	private parseRelational(): unknown {
		let left = this.parseAdditive();
		this.ws();
		while (true) {
			if (this.match("<=")) { left = (left as number) <= (this.parseAdditive() as number); }
			else if (this.match(">=")) { left = (left as number) >= (this.parseAdditive() as number); }
			else if (this.peek() === "<" && this.peek(1) !== "=") { this.pos++; left = (left as number) < (this.parseAdditive() as number); }
			else if (this.peek() === ">" && this.peek(1) !== "=") { this.pos++; left = (left as number) > (this.parseAdditive() as number); }
			else break;
			this.ws();
		}
		return left;
	}

	private parseAdditive(): unknown {
		let left = this.parseMultiplicative();
		this.ws();
		while (this.peek() === "+" || this.peek() === "-") {
			const op = this.eat();
			const right = this.parseMultiplicative();
			if (op === "+") {
				left = typeof left === "string" || typeof right === "string"
					? String((left ?? "") as string | number | boolean) + String((right ?? "") as string | number | boolean)
					: (left as number) + (right as number);
			} else {
				left = (left as number) - (right as number);
			}
			this.ws();
		}
		return left;
	}

	private parseMultiplicative(): unknown {
		let left = this.parseUnary();
		this.ws();
		while (this.pos < this.src.length && "*/%".includes(this.peek())) {
			const op = this.eat();
			const right = this.parseUnary();
			if (op === "*") left = (left as number) * (right as number);
			else if (op === "/") left = (left as number) / (right as number);
			else left = (left as number) % (right as number);
			this.ws();
		}
		return left;
	}

	private parseUnary(): unknown {
		this.ws();
		if (this.match("!")) return !this.parseUnary();
		// Unary minus: only when preceded by an operator, open paren, or start of input
		if (this.peek() === "-") {
			const prevNonWS = this.src.slice(0, this.pos).trimEnd().slice(-1);
			if (!prevNonWS || /[+\-*/%(<>=!&|?,:]/.test(prevNonWS)) {
				this.pos++;
				return -(this.parseUnary() as number);
			}
		}
		return this.parsePrimary();
	}

	private parsePrimary(): unknown {
		this.ws();
		const c = this.peek();

		if (c === "(") {
			this.pos++;
			const v = this.parseTernary();
			this.ws();
			if (this.peek() !== ")") throw new Error("Expected ')'");
			this.pos++;
			return v;
		}

		if (c === '"' || c === "'") {
			const q = this.eat();
			let s = "";
			while (this.pos < this.src.length && this.peek() !== q) {
				if (this.peek() === "\\") {
					this.pos++;
					const esc = this.eat();
					s += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
				} else {
					s += this.eat();
				}
			}
			if (this.pos >= this.src.length) throw new Error("Unterminated string");
			this.pos++;
			return s;
		}

		if (/\d/.test(c)) {
			let s = "";
			while (this.pos < this.src.length && /[\d.]/.test(this.peek())) s += this.eat();
			if (this.peek() === "e" || this.peek() === "E") {
				s += this.eat();
				if (this.peek() === "+" || this.peek() === "-") s += this.eat();
				while (this.pos < this.src.length && /\d/.test(this.peek())) s += this.eat();
			}
			return parseFloat(s);
		}

		if (/[a-zA-Z_$]/.test(c)) {
			let name = "";
			while (this.pos < this.src.length && /[a-zA-Z0-9_$]/.test(this.peek())) name += this.eat();
			if (name === "true") return true;
			if (name === "false") return false;
			if (name === "null") return null;
			if (name === "undefined") return undefined;
			return Object.prototype.hasOwnProperty.call(this.ctx, name) ? this.ctx[name] : null;
		}

		if (!c) throw new Error("Unexpected end of expression");
		throw new Error(`Unexpected character: "${c}"`);
	}
}
