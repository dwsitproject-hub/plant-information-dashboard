# Tank gauging: set up and schedule the poller

Bontang and Tanjung Pura read their tanks from TankVision (NXA) gauge units instead of logsheets. This is the same approach as Jetty Planning System. The scripts run **once per call**. The **schedule is cron on the backend host**, not a timer inside the app.

| Job | Script | How often | What it writes |
| --- | --- | --- | --- |
| Poll | `Backend/scripts/run-tank-gauging-poll.js` | cron every 5 minutes; it polls a site only at its round times | `tank_gauging_latest`, `tank_gauging_samples`, the daily rounds into `soundings`, each round's attempts into `tank_gauging_round_runs` |
| Backfill | `Backend/scripts/backfill-tank-gauging.js` | by hand, once, or after a long outage | past daily rounds into `soundings`, from the gauges' own archive |
| Purge | `Backend/scripts/purge-tank-gauging-samples.js` | once a day | archives and deletes old samples, logged in `tank_gauging_purge_log` |

The daily rounds in `soundings` are the history: they are never purged. The history charts, the commodity dialog and both Commodity Stock Movement sections read them.

## When it polls

The poll follows the **Round times** on the Tank gauging page (**Daily rounds**), in each site's own timezone (default **06:30** and **14:30**). Cron starts the script every 5 minutes; most runs find nothing due and print `nothing due`.

1. When a round time has passed and that round is not done, the site is polled: every gauge system of the site that is switched on.
2. If the attempt fails (a gauge does not answer, or its archive cannot be read), it is tried again **every 20 minutes, up to 6 times**. After the sixth retry the round is marked failed. Change this with `TANK_GAUGING_RETRY_MINUTES` and `TANK_GAUGING_MAX_RETRIES` on the API.
3. Each round's attempts (status, tries, last try, tanks saved, last problem) are kept in `tank_gauging_round_runs` and listed on the Tank gauging page under Daily rounds.
4. Yesterday's and today's rounds are checked every run, so a round missed while the poller was down is still taken the next time it runs. For anything older, use the backfill below.

## What happens on each poll

1. For each gauge system that is switched on, read its tank list and add any new tank (a tank keeps its identity by host, unit and number, so renaming it on the gauge does not create a second one).
2. Read the live values: level, temperature, density, volume, mass, flow, product and status. Store the latest reading and one sample per tank.
3. Save the round for each tank: from that reading when it is within **Match within** (30 minutes) of the round time, otherwise from the **gauge's own archive** at the round time. So a retry an hour late still saves the value at 06:30, not the value an hour later.
   - A reading the unit marks as no data, failed or invalid is not turned into a round. A tank that reads a level of 0 with nothing else to back it up is skipped too.

The units are slow, about one second a call. Gauges on different hosts, and the units behind the Tanjung Pura gateway, are read side by side; each one is read one call at a time.

### The gauges' own archive

Each TankVision unit records level, temperature, density, volume and mass every 5 minutes and keeps months of it (Bontang and Tanjung Pura answer for at least 100 days back). The poller reads it the way the TankVision historical trend page does: one value of one tank per call, between two times. Tanjung Pura's units are behind a gateway and are reached through its tunnel by their own address; they archive Product Mass and Gross Observed Volume, which the poller uses in place of Total Mass and Total Observed Volume (the masses are the same figure on those units).

Live Ops shows today's tanks from the latest reading, and says when it was taken (**Last reading … ago**). Because the gauges are read at round times, that can be hours ago and still current. A reading is flagged as old (amber, `stale` on the tank) only when it was taken before the last round time that has passed, plus 30 minutes for the poll to finish: the poll of that round did not get through. The figures stay on screen, so a late poller does not blank the site. A tank that no longer appears on its gauge (or whose gauge was removed) shows as NO DATA and stops counting in stock; its history stays.

If Live Ops shows an amber reading, check the Daily rounds list on the Tank gauging page, then the cron job and its log (see [Check that it works](#check-that-it-works)).

Changing a gauge system's address in Master > Tank gauging moves its tanks to the new address. It does not create new tanks.

## Before you start

1. Migration `011_tank_gauging.sql` is applied. The deploy script runs it. You can also run `npm run migrate` in `Backend`.
2. The backend host can reach every gauge address. Test from the host:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://172.16.250.15/index.esp
   ```

3. The site is switched on in Master, Site, and the people who set this up have **Master tanks, edit** rights.
4. `Backend/.env` has `JWT_SECRET`. Gauge passwords are encrypted with it, so it must not change later.

## Add the gauge systems

Open **Master, Tank gauging**, pick the site, and use **Add gauge system**.

| Site | Address | Sign-in |
| --- | --- | --- |
| Bontang (SITE-0009) | `http://172.16.250.15`, `http://172.16.250.16`, `http://172.16.11.77` | none |
| Bontang, OLEO unit | `http://172.16.250.17` | user and password. Add it when the unit is back online. |
| Tanjung Pura (SITE-0017) | `http://172.16.11.28` (or `http://atg-pura.kpndomain.com`, the same gateway) | none |

Enter passwords on the screen only. They are stored encrypted and never shown again.

Use **Test connection** on each row. It reads the tank list and shows how many units and tanks it found. Then use **Poll now** once to see the tanks and readings appear.

> **Tanjung Pura** is one gateway (TC-01) holding four units (TS-01 to TS-04) that each number their tanks from 1. The poller reads each unit in turn by name (`DATATYPE=39` with `REMOTE=<unit>`), so one source covers all 60 tanks. Use `http://172.16.11.28`, which needs no sign-in. The gauge gives no capacity, so load it from the stock report with `node scripts/load-tank-capacities.js scripts/tank-capacities/tanjung-pura.json` (see [STAGING-ROLLOUT-BONTANG-TJ-PURA.md](STAGING-ROLLOUT-BONTANG-TJ-PURA.md)).

## Schedule it

On the backend host (`172.28.92.57`), as root. The jobs go in their own file under `/etc/cron.d/`, not in root's crontab: that host is shared with other products, and a rewrite of root's crontab by another team would drop PID's lines.

```bash
touch /var/log/pid-tank-gauging-poll.log /var/log/pid-tank-gauging-purge.log
cat > /etc/cron.d/pid-tank-gauging <<'CRON'
# Plant Information Dashboard: tank gauging. Times are the server's own clock (SIT: Asia/Shanghai, UTC+8).
SHELL=/bin/bash
# Every 5 minutes, check each site's round times (Master > Tank gauging > Daily rounds) and poll the sites
# whose round is due, or whose failed attempt is due for a retry (every 20 minutes, up to 6 times).
*/5 * * * * root cd /opt/plant-information-dashboard && docker compose --env-file Backend/.env -f docker-compose.backend-api-only.yml exec -T pid-api node scripts/run-tank-gauging-poll.js >> /var/log/pid-tank-gauging-poll.log 2>&1
# Sample purge: every day at 02:20 server time
20 2 * * * root cd /opt/plant-information-dashboard && docker compose --env-file Backend/.env -f docker-compose.backend-api-only.yml exec -T pid-api node scripts/purge-tank-gauging-samples.js >> /var/log/pid-tank-gauging-purge.log 2>&1
CRON
chmod 644 /etc/cron.d/pid-tank-gauging
```

The first field is how often the schedule is checked, not how often the gauges are read. Every 5 minutes means a round is polled at most 5 minutes after its time, and a retry at most 5 minutes after it is due. To change when the gauges are read, change the Round times on the Tank gauging page, not cron.

If the file already exists with `*/15`, run the block above again; it replaces the file.

**Cron runs on the server's own clock.** On the SIT API host that is **Asia/Shanghai (UTC+8)**. Check it with `timedatectl`. `CRON_TZ=` lines are ignored by this server's cron, so a time written for WIB runs an hour early.

The round times (06:30 and 14:30 by default) are in each site's own timezone and are set on the Tank gauging page under **Daily rounds**, not in cron. The script works out each site's times itself, so the server clock does not matter.

Only one poll runs at a time. If a run is still going when the next starts, the new one exits quietly.

## Check that it works

```bash
cd /opt/plant-information-dashboard

# The schedule by hand: polls only what is due. Prints `nothing due` or a JSON summary. Exit code 1 means an attempt failed.
docker compose --env-file Backend/.env -f docker-compose.backend-api-only.yml exec -T pid-api node scripts/run-tank-gauging-poll.js --siteId=bontang

# Poll every gauge now, whatever the time (same as Poll now on the Tank gauging page).
docker compose --env-file Backend/.env -f docker-compose.backend-api-only.yml exec -T pid-api node scripts/run-tank-gauging-poll.js --now --siteId=bontang

tail -n 40 /var/log/pid-tank-gauging-poll.log
```

- On the Tank gauging page, each gauge system shows its last poll, whether it worked, and the last error. Under Daily rounds, each recent round shows Saved, Retrying (with the next try) or Failed, its tries, and the last problem.
- Rounds appear in Live Ops after the first round time has passed and a poll has run. Until then the Tank gauging page shows the latest readings.

## Fill past days from the gauges' archive

Use this once when a site is first set up, or after the poller was down for more than a day. It reads each missing round of each tank from the gauge's archive at the round time and saves it. Rounds already saved are kept, so it is safe to run again; a second run only fills what is still missing.

```bash
cd /opt/plant-information-dashboard

# Plan only: how many rounds are missing and how many gauge calls that is.
docker compose --env-file Backend/.env -f docker-compose.backend-api-only.yml exec -T pid-api node scripts/backfill-tank-gauging.js --sites=bontang,tanjung-pura --days=30

# Read and save, in the background inside the container, then follow the log.
docker compose --env-file Backend/.env -f docker-compose.backend-api-only.yml exec -d pid-api sh -c "node scripts/backfill-tank-gauging.js --sites=bontang,tanjung-pura --days=30 --apply > /app/backups/gauge-backfill.log 2>&1"
docker compose --env-file Backend/.env -f docker-compose.backend-api-only.yml exec -T pid-api tail -f /app/backups/gauge-backfill.log
```

It prints a line per site and day (`saved`, `with no reading`, calls, time). 30 days for Bontang and Tanjung Pura is about 1.5 hours. Tanks the gauge has no value for at that time (a faulty or idle gauge) are counted as `with no reading`, as on a normal day. The product on a past round is the product the gauge shows now; the archive does not keep products.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Tank list HTTP 204 (empty)` | The unit was not ready. It is retried once. If it stays, the unit may be busy or the address is wrong. |
| `... did not answer` or a timeout | The host cannot reach the gauge. Check the network from the backend host, not from your PC. |
| `live values HTTP 200` with no readings | The unit wants a sign-in. Set the sign-in type on the gauge system. |
| `This host has 4 units ...` | A controller with several units (Tanjung Pura). Not set up yet, as noted above. |
| Tank shows `NODATA` or `Fail` | The gauge itself has no valid reading. No round is saved for it. |
| Many `INIT` statuses | Normal. The units report real density and mass with `INIT`. Those values are used. |
| No rounds for a site | Check the Daily rounds list on the Tank gauging page, that cron runs (`tail` the log: a line every 5 minutes), and that the site's timezone is right in Master, Site. |
| A round shows Failed | All 7 tries failed. Fix the cause (usually the network to the gauge), then run the backfill for that day: `--days=1` or `--days=2`. |
| `archive HTTP ...` | The gauge answered live values but not its archive. It is retried with the round. |

## Retention

| Setting | Default | Meaning |
| --- | --- | --- |
| `TANK_GAUGING_SAMPLE_ACTIVE_DAYS` | 30 | samples older than this are archived |
| `TANK_GAUGING_SAMPLE_ARCHIVE_DAYS` | 7 | archived samples older than this are deleted |

Set them in `Backend/.env` and pass them to the container if you change them.
