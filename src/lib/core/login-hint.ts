import { programInfo } from "../programs/catalog";
import type { ProgramConfig } from "./model";

/** What the rejected-login warning says beyond the program's own answer. */
export interface LoginHint {
  /** A fact about the card that makes the rejection likely — only when the card holds no login at all. */
  cause?: string;
  /** What the user does, in the words of the program's dialog. */
  action: string;
}

const NONE_SET = "no login is set on its card";

/**
 * The warning of a rejected login names what the card of THIS program holds — a program without an API key never
 * hears of one, and a card without any login says so (the most likely cause: the switch of the dialog is off).
 *
 * @param cfg the program's settings row
 * @returns the cause (if the card holds no login) and the action
 */
export function loginHint(cfg: ProgramConfig): LoginHint {
  const hasUser = cfg.username.trim() !== "";
  const hasKey = cfg.apiKey.trim() !== "";
  switch (programInfo(cfg.type)?.login) {
    case "account":
      return { action: "check e-mail and password on its card" };
    case "password":
      return { action: "check the password on its card" };
    case "apiKey":
      return { action: "check the API key on its card" };
    case "secret":
      return hasKey
        ? { action: "check the RPC secret on its card" }
        : { cause: NONE_SET, action: "enter the RPC secret on its card" };
    case "user":
      return hasUser
        ? { action: "check user and password on its card" }
        : { cause: NONE_SET, action: "enter user and password on its card" };
    case "optionalUser":
      return hasUser
        ? { action: "check user and password on its card" }
        : {
            cause: NONE_SET,
            action: 'switch on "The program asks for a login" on its card and enter user and password',
          };
    case "userOrKey":
    case "keyOrUser":
      if (hasKey) {
        return { action: "check the API key on its card" };
      }
      return hasUser
        ? { action: "check user and password on its card" }
        : { cause: NONE_SET, action: "enter user and password or an API key on its card" };
    default:
      return { action: "check the address and the login on its card" };
  }
}
