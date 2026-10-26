# Phone numbers

The default `builtin.phones` keeps its original `[REDACTED_PHONE]` marker and reports an explicit trigger only when it replaces a number.

## Recognition

- Explicit `+` / full-width `＋` international numbers use the country calling code and general national-number patterns from Google's pinned libphonenumber metadata. Spaces, parentheses, hyphens and dots are accepted; optional international `(0)` trunk notation is supported. International numbers must fit E.164's 15-digit maximum.
- Phone-labelled national numbers use those same general patterns and national trunk prefixes. Labels include phone/phone number, telephone/tel, mobile/cell, and common French, German, Spanish, Portuguese, Russian, Chinese, Japanese and Korean terms, including quoted JSON keys. Labelled `00` international dialing notation is accepted.
- Familiar formatted North American numbers and the previous standalone mainland-China mobile formats remain recognized without a label.
- Other bare national digit strings are ambiguous and need a phone label or an international prefix. Ordinary order numbers, dates, IDs, versions, paths and embedded key fragments are not treated as phones merely because they contain enough digits. Short codes, emergency numbers and extensions are outside this rule's promised coverage.

The snapshot contains 245 geographical regions plus nine nongeographical plans, including US/Canada, UK/Ireland, Europe, India, China/Hong Kong/Taiwan, Japan, South Korea, Southeast Asia, Australia/New Zealand, Latin America, Africa and the Middle East. Shared calling codes do not establish the number's geographical origin. This is offline general-format recognition, not proof that a subscriber number was allocated, is active or belongs to a person. Metadata can become stale; not every phone notation is recognized.

## Provenance and maintenance

Source: [Google libphonenumber PhoneNumberMetadata.xml](https://github.com/google/libphonenumber/blob/1ae0d623301b302f828628dfc368c983e8d27141/resources/PhoneNumberMetadata.xml), commit `1ae0d623301b302f828628dfc368c983e8d27141`, XML SHA256 `b6491939ddaeb9d585a34fe0f0ebd096e83c5ac9a1c5d6dddf38ba4b162b28ca`.

`phone-number-plans.ts` contains deduplicated `[countryCode, generalDesc.nationalNumberPattern, nationalPrefix]` tuples, with XML pattern whitespace removed. The 254 XML territories yield 247 distinct tuples. `fixtures/phone-examples.json` preserves one upstream example per territory: fixed-line first, then mobile, then another available type. Tests exercise all 254 international examples through the actual bounded runner. These are published upstream test examples, not user data. Required attribution is in `THIRD_PARTY_NOTICES.md`; no runtime package or network lookup is added.

The source is injected as a self-contained plugin within the existing 16KiB source limit and unchanged runtime deadlines. Keep the source pin, metadata tuples, examples and attribution together when refreshing it.

International numbering limit: [ITU-T E.164 (February 2026)](https://www.itu.int/rec/T-REC-E.164-202602-I/en).

Saved configurations keep their installed sources and customizations. This change does not silently replace existing pipelines. Controlled test-account updates verify exact known-default source bytes and preserve flags, order, custom nodes and deletions.
