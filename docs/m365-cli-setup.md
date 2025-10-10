# m365 CLI unter WSL aktivieren

1. **NVM-Bin-Verzeichnis in den PATH setzen**

   ```bash
   export PATH="$HOME/.nvm/versions/node/v20.19.2/bin:$PATH"
   ```

2. **Shell-Cache leeren und Binary prüfen**

   ```bash
   hash -r
   which m365          # sollte auf ~/.nvm/.../m365 verweisen
   ```

3. **Alias setzen, falls andere Installationen gefunden werden**

   ```bash
   alias m365="$HOME/.nvm/versions/node/v20.19.2/bin/m365"
   type -a m365        # Alias muss an erster Stelle stehen
   ```

4. **Ausführungsrechte sicherstellen** (einmalig)

   ```bash
   chmod +x ~/.nvm/versions/node/v20.19.2/bin/m365
   ```

5. **Login starten**

   ```bash
   m365 login
   ```

6. **Optional:** `export` und `alias` in `~/.bashrc` übernehmen, damit sie bei neuen Shells automatisch aktiv sind.
