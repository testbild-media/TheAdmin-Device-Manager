# TheAdmin Device Manager

TheAdmin Device Manager is a companion application for **TheAdmin**.

It is intended to manage and maintain device definitions used by TheAdmin and is available for Windows, Linux and macOS.

## Development Status

TheAdmin is currently under active development.

This application, its features, behavior and file formats may change as development continues.

## Platform Support

- Windows
- Linux
- macOS

## Library workflow

On first launch, the app creates one user library under the current user's
Documents folder and imports the validated devices from the
[default device library](https://github.com/testbild-media/TheAdmin-Device-Library)
`main` branch.

A library contains:

```text
device-assets/
  library.json
  <vendor>/
    <model>/
      device.json
      front.svg
```

The Library menu can open the user library, open an external library folder or
`.adlib` archive, edit metadata, merge another `.adlib`, export a copy, and show
the active library in the system file manager. Saving changes to an opened
`.adlib` overwrites that archive; **Export library** always writes a separate
copy.

The canonical metadata fields are `name`, `version`, `updated`, `author`, and
`deviceCount`. The `updated` and `deviceCount` values are maintained
automatically.
