import { z } from "zod";
import type { Db } from "../db/port";
import { RecordWrite } from "./record-write";

export const CustomAttributeKeySchema = z
	.string()
	.regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** Keep declared keys separate from the built-in attributes and tags. */
export const customAttributeKey = (key: string): string => `custom.${key}`;

/** The declared key an attribute stores, or undefined when it is not a declared one. */
export const declaredKeyOf = (stored: string): string | undefined =>
	stored.startsWith("custom.") ? stored.slice("custom.".length) : undefined;

export const setCustomAttribute = (
	db: Db,
	threadId: string,
	key: string,
	value: string | null,
): void =>
	RecordWrite.setAttribute(db, threadId, customAttributeKey(key), value);
