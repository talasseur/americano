# UMA Americano

Petite web app pour suivre un tournoi de padel au format Americano : planning automatique (chacun joue avec chacun), saisie des scores en 16 points, classement en direct et podium.

- Front : HTML/CSS/JS sans build, hébergé sur GitHub Pages.
- Données : Supabase (schéma dans [`supabase/schema.sql`](supabase/schema.sql)). Lecture publique, écritures protégées par un PIN admin vérifié côté base.

## Lancer en local

```bash
python3 -m http.server 5173
```

## Définir le PIN admin

Dans l'éditeur SQL de Supabase :

```sql
insert into admin_secret (id, pin_hash)
values (1, extensions.crypt('TON_PIN', extensions.gen_salt('bf')))
on conflict (id) do update set pin_hash = excluded.pin_hash;
```
