---
name: style-extract
allowedTools: [extract_style]
roles: [vision]
checkpoints: []
---

# Style extract

Make a draft style from one reference video the user named (styles spec "Part C"). Call
`extract_style` once with the link or file and a short name for the style. The tool measures the
reference (cuts, colours, captions, speaker time), asks the vision model to describe its look, and
writes an untrusted draft style that re-skins existing templates, with a report page.

Then tell the user, in two or three sentences: the new style id, which style it extends, what the
report found (and any layouts listed as not built), and that the draft is an approximation they can
accept or discard in the style gallery. Never say the style copies the reference.
