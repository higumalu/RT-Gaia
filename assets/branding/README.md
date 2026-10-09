# Branding assets

`rt-gaia-icon.png` (1254 × 1254 px) is the source image of the RT-Gaia icon. The repository `README.md`
references it directly.

The viewer serves its own copies from `apps/viewer/public/branding/`, so that the Vite development
server, `vite preview` and the deployed build can all serve them:

| File | Used for |
|---|---|
| `rt-gaia-icon-64.png` | Logo on the login page and in the navigation, favicon |
| `rt-gaia-icon-192.png` | Apple touch icon and web app manifest |
| `rt-gaia-icon-512.png` | Web app manifest |
| `rt-gaia-icon.png` | Full-size copy of the source image |

When you change the source image, update the copy and regenerate the 64, 192 and 512 px versions. Do not
reference images outside `apps/viewer` from the frontend: the Vite development server does not serve
files outside its allowed directories.
