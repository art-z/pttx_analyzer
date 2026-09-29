# Fonts

Keep each font family in its own directory. Fontconfig scans `/fonts`
recursively, so nested directories are supported.

Example:

```text
fonts/
  Play/
    Play-Regular.ttf
    Play-Bold.ttf
  Montserrat/
    Montserrat-Regular.otf
    Montserrat-SemiBold.otf
```

Directory names are only for organization. Font matching uses the family,
style, weight, and PostScript names stored inside each font file.

`font-aliases.json` explicitly maps family names found in source PPTX files to
the canonical family and concrete font files. The compiler uses this registry
for JSON typography and TTF metrics. `/etc/fonts/local.conf` must contain the
same aliases so LibreOffice uses the identical family while rendering PNGs.
