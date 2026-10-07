/**
 * Payment reference normalisation.
 *
 * Text memos are typed by people into wallets, so the same invoice arrives as
 * `INV-00123`, `inv #00123`, `Invoice 00123` or `ＩＮＶ００１２３`. This maps
 * all of those to one canonical form, `00123`, and the same function is
 * applied to the expectation's reference, so they compare equal.
 *
 * Steps: NFKC (full-width and compatibility forms) → drop zero-width and
 * control characters → upper-case → drop leading prefixes (`INVOICE`, `INV`,
 * `REF`, `NO`, `#`) → drop separators (space - _ . / # :).
 *
 * Deliberately conservative: leading zeros are kept (`00123` is not `123`),
 * and nothing is stripped from the middle of a reference.
 */

const INVISIBLE = /[​-‍⁠﻿\p{Cc}]/gu
const PREFIX = /^(?:INVOICE|INV|REF|NO|#)(?=[\s\-_./#:]|\d|$)[\s\-_./#:]*/
const SEPARATORS = /[\s\-_./#:]+/g

export function normalizeReference(text: string): string {
  let s = text.normalize('NFKC').replace(INVISIBLE, '').toUpperCase().trim()
  // Prefixes can stack: "Invoice No. 123", "REF #123".
  for (let previous = ''; previous !== s; ) {
    previous = s
    s = s.replace(PREFIX, '')
  }
  return s.replace(SEPARATORS, '')
}
