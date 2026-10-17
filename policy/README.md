# Employer policy

Real terms do not belong in git. `employers.example.txt` is a fake sample. Copy it to `employers.local.txt`, which is gitignored, replace the Contoso Example Corp lines, and load that file with `pnpm policy:apply`.

## What a match is

The filter sees one whole write: a note body, a fact statement, or a journal entry, including its title and tags. It does not decide sentence by sentence. A subject in the first sentence and a qualifier in a later sentence still match.

## Kinds

| Kind | Effect |
| --- | --- |
| `context_subject` | Names the thing the policy is about, usually an organization. A multi-word term matches as a substring. |
| `context_qualifier` | A single word such as `customer` or `deal`. Together with a subject, it marks the write `employer_context`. |
| `employer`, `deny` | Reject the write on their own. |
| `allow` | Escape hatch. If an allow term matches, a subject-plus-qualifier hit is kept. |

A write is rejected for context only when it contains at least one `context_subject` and one `context_qualifier`, and no `allow` term matches.

## Plurals

A single-word term also matches a plural on a word boundary: an optional trailing `s` or `es`, and a consonant-`y` term also matches `ies`. `customer` matches `customers`. `company` matches `companies`. `customerish` does not match `customer`. Multi-word terms stay exact substrings and do not grow a plural.
