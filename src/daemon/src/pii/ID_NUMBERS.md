# ID numbers

`builtin.id-cards` is one default filter called **ID numbers**. It replaces matches with `[REDACTED_ID_CARD]`. Its persisted ID and replacement marker remain stable.

This is local text detection. A matching structure or checksum does not establish that a document was issued, is current, or belongs to anyone. This filter does not cover every document in the listed countries, passports, document images, or attachments.

## Supported formats

“Label” means an immediately preceding document/type name, case-insensitive, with optional number / no. / nummer / n°, spaces, tab, colon, equals sign, hash sign or JSON quotes. Examples: `SSN: 219-09-9999` and `{"ssn": "219099999"}`. Labels must be on the same line and within 96 characters; intervening prose is not accepted. `other_ssn` and generic `id` do not qualify. Common local-language labels are supported as listed below.

| Country / region | Document / number | Checks performed | Label needed |
| --- | --- | --- | --- |
| China (mainland) | 18-character resident identity number | encoded calendar date, nonzero sequence, MOD 11-2 checksum | No |
| Hong Kong | HKID, one/two letters + 6 digits + check digit | weighted mod 11; check digit 0–9/A, with optional parentheses | No |
| Taiwan | citizen ID: letter + 1/2 + 8 digits | official letter mapping and weighted mod 10 | No |
| United States | SSN, 9 digits, compact or 3-2-4 grouping | exclude 000/666/900–999 area, 00 group, 0000 serial and repeated-digit placeholders; no checksum | SSN, Social Security number |
| Canada | SIN, 9 digits, compact or 3-3-3 grouping | exclude 0/8 prefix; Luhn; repeated-digit placeholders | SIN, NAS, Social Insurance Number, numéro d’assurance sociale |
| United Kingdom | NINO: 2 letters + 6 digits + A–D, optional pair spaces | HMRC allowed letters and excluded prefixes; no checksum | NINO, National Insurance number |
| Germany | personal Steuer-ID, 11 digits, compact or 2-3-3-3 grouping | nonzero prefix; one digit repeated twice/three times, no triple run; MOD 11, 10 | Steuer-ID, Steueridentifikationsnummer, IdNr., German tax ID |
| Germany | Personalausweis number, 9 allowed alphanumerics | **format only**; historical zeroes accepted | Personalausweis, Ausweisnummer, German ID |
| France | NIR **with its 2-digit control key**, 15 characters; compact or 1-2-2-2-3-3-2 grouping | 1/2 sex prefix, month structure, mod 97; Corsica 2A/2B normalization | NIR, numéro de sécurité sociale, French Social Security |
| France | CNI: old 12 digits or new 9 alphanumerics | **format only** | CNI, carte nationale d’identité, French ID |
| Spain | DNI/NIF: 8 digits + letter; NIE: X/Y/Z + 7 digits + letter | mod 23 letter, NIE prefix conversion; optional space/hyphen before final letter | No |
| Italy | personal codice fiscale, 16 alphanumerics | structure, encoded birth date, omocodia substitutions, parity checksum | No |
| Italy | electronic identity card (CIE): 2 letters + 5 digits + 2 letters | **format only** | CIE, carta d’identità, Italian ID |
| India | Aadhaar: 12 digits; compact or 4-4-4 grouping | prefix 2–9, Verhoeff, repeated-digit placeholders | Aadhaar, Aadhar, आधार, आधार संख्या, आधार नंबर |
| Japan | My Number: 12 digits; compact or 4-4-4 grouping | official weighted checksum; repeated-digit placeholders | My Number, 個人番号, マイナンバー |
| South Korea | resident/foreign registration number: 13 digits; compact or 6-7 grouping | birth date and 1–8 century/sex code; no legacy checksum requirement, so randomized numbers are included | RRN, Resident Registration number, 주민등록번호, 외국인등록번호 |
| Singapore | NRIC/FIN: S/T/F/G/M + 7 digits + letter | **format only**; issuer checksum is not checked | NRIC, FIN |
| Australia | modern TFN: 9 digits; compact or 3-3-3 grouping | weighted mod 11; repeated-digit placeholders | TFN, Tax File number |
| Brazil | CPF: 11 digits; compact or dotted 3-3-3-2 form | both mod 11 check digits; repeated-digit placeholders | CPF, Cadastro de Pessoas Físicas |

Unlabeled ambiguous numbers are left unchanged by **this filter**. Other enabled categories still apply independently: a number that also matches a phone or bank-card pattern can be redacted by that category. Ordinary reference tests exercise the whole default chain, not only this node. Matches embedded in longer ASCII words, underscore identifiers, connected paths/references, UUIDs or hashes are excluded. This is deliberately narrower than filtering every numeric string.

## Rule sources

Format references below come from issuing authorities, public standards, or jurisdiction-supplied OECD material. Supplementary algorithm references are identified separately; an official format reference does not imply the issuer published the implementation’s checksum algorithm. No third-party implementation is bundled.

- China: [GB 11643-1999](https://zjw.beijing.gov.cn/Portals/0/zhuanti/fazhan/%E8%BA%AB%E4%BB%BD%E8%AF%81GB11643-1999.pdf).
- Hong Kong: [Digital Policy Office HKID schema](https://www.digitalpolicy.gov.hk/en/our_work/data_governance/policies_standards/interoperability_framework/common_schemas/hkid_number/index.html). Supplementary algorithm reference: [hkid_ops author documentation](https://docs.rs/hkid_ops/latest/hkid_ops/index.html).
- Taiwan: [Ministry of the Interior identity-number checking appendix](https://gazette.nat.gov.tw/EG_FileManager/eguploadpub/eg027002/ch04/type2/gov30/num3/images/BB.pdf). Citizen IDs only; resident certificate formats are outside this version.
- US: [SSA impossible SSN groups](https://www.ssa.gov/employer/randomizationfaqs.html).
- Canada: [Service Canada SIN](https://www.canada.ca/en/employment-social-development/services/sin.html). Supplementary prefix/Luhn reference: [python-stdnum SIN documentation](https://arthurdejong.org/python-stdnum/doc/2.1/stdnum.ca.sin).
- UK: [HMRC NINO format and excluded prefixes](https://www.gov.uk/hmrc-internal-manuals/national-insurance-manual/nim39110).
- Germany: [ELSTER structure and checksum, section 2.2](https://download.elster.de/download/schnittstellen/Pruefung_der_Steuer_und_Steueridentifikatsnummer.pdf); [Personalausweis permitted characters](https://www.gesetze-im-internet.de/pauswv/anlage_3.html). Card-number matching is structural, not MRZ verification.
- France: [Service Public NIR structure](https://www.service-public.gouv.fr/particuliers/vosdroits/F33078), [Education Ministry mod97 explanation](https://pedagogie.ac-limoges.fr/maths/accueil/html/lycee/pages/Option-maths-TL/Arithm/insee.pdf), [PRADO old CNI specimen](https://www.consilium.europa.eu/prado/en/FRA-BO-02002/index.html), [PRADO new CNI specimen](https://www.consilium.europa.eu/prado/en/FRA-BO-03001/index.html). NIR without its control key, provisional prefixes and unlisted special encodings are outside this version. CNI matching is format only.
- Spain: [Interior Ministry DNI/NIE control-letter algorithm](https://www.interior.gob.es/opencms/en/servicios-al-ciudadano/tramites-y-gestiones/dni/calculo-del-digito-de-control-del-nif-nie/index.html).
- Italy: [Finance Ministry fiscal-code specification](https://def.finanze.it/DocTribFrontend/executePrintArticolo.do?codiceOrdinamento=60A+++++0000000&id=%7B8F0DD094-2E4C-4BBA-AD3D-92A2F6DD1050%7D&idAttoNormativo=%7B04AB9404-46E7-4072-B414-892639727A96%7D), [Interior Ministry CIE serial format](https://www.cartaidentita.interno.gov.it/cose-la-carta/caratteristiche-del-documento/).
- India: [UIDAI compendium, Aadhaar/VID Verhoeff checksum](https://uidai.gov.in/images/resource/compendium_auth_28022018.pdf). VID itself is outside this version.
- Japan: [e-Gov individual-number checksum regulation, Article 5](https://laws.e-gov.go.jp/law/426M60000008085); [jurisdiction-supplied OECD individual-number description](https://www.oecd.org/tax/automatic-exchange/crs-implementation-and-assistance/tax-identification-numbers/Japan-TIN.pdf).
- South Korea: [jurisdiction-supplied OECD RRN format](https://www.oecd.org/content/dam/oecd/en/topics/policy-issue-focus/aeoi/korea-tin.pdf), [Interior Ministry2020 randomization change](https://mois.go.kr/plan2020/download/2020plan.pdf).
- Singapore: [ICA S/T/F/G/M prefixes and FIN format](https://www.ica.gov.sg/news-and-publications/newsroom/media-release/new-m-fin-series-to-be-introduced-from-1-january-2022). Its example is used as format evidence, not as a claim about the checksum.
- Australia: [jurisdiction-supplied OECD TFN format](https://www.oecd.org/tax/automatic-exchange/crs-implementation-and-assistance/tax-identification-numbers/Australia-TIN.pdf). Supplementary algorithm reference: [Clearwater validation author](https://clearwater.com.au/code/tfn). Legacy 8-digit TFNs are outside this version.
- Brazil: [Receita Federal CPF checksum specification, page 17](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/sped/manuais-e-financeira/versao-2.x/manual-e-financeira-anexo-v-versao-2-0-1-leiaute-modulo-de-repasse.pdf).

## Saved configurations

Default source is copied when a bot first initializes its local configuration. A daemon upgrade does not replace an initialized rule, enable a disabled rule, restore a deleted rule or overwrite custom filters. Existing configured bots retain their installed sources. This feature introduces no automatic migration or replacement CLI.
