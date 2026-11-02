# Discord-Serverboosts

Serverboosts sind eine Discord-Funktion und **vollständig getrennt** von bezahlten Ranked-Aufträgen. Der Bot nennt keine Boost-Preise, verspricht keine Rabatte, automatisiert keine Käufe und fragt nie nach Nitro- oder Zahlungsdaten.

## Was Discord laut offizieller API-Doku bereitstellt

Quelle: offizielle Discord-API-Dokumentation (Repository `discord/discord-api-docs`, Stand 30.10.2026).

| Datenquelle | Inhalt | Zuverlässigkeit |
|---|---|---|
| Systemnachricht `GUILD_BOOST` (Typ 8) bzw. `GUILD_BOOST_TIER_1–3` (Typ 9–11) | erscheint im **Systemkanal**, wenn jemand boostet (auch bei weiteren Boosts derselben Person); Autor = Booster | nur wenn ein Systemkanal gesetzt ist und das Flag `SUPPRESS_PREMIUM_SUBSCRIPTIONS` nicht aktiv ist („Boost-Nachrichten senden“ an) |
| Guild-Member-Feld `premium_since` (Event `GUILD_MEMBER_UPDATE`) | Zeitpunkt, seit dem die Person boostet | benötigt den Intent **Server Members**; ändert sich **nicht** bei zusätzlichen Boosts derselben Person |
| Guild-Felder `premium_tier` und `premium_subscription_count` | Boost-Stufe und aktuelle Anzahl Boosts des Servers | Anzahl ist laut Doku optional; der Bot liest sie frisch per REST und zeigt sie nur, wenn sie geliefert wird |
| Rollen-Tag `premium_subscriber` | kennzeichnet die von Discord verwaltete Booster-Rolle | verwaltete Rolle, wird nie vom Bot verändert |

Eine *individuelle* Anzahl der Boosts einer Person stellt Discord nicht zuverlässig bereit. Der Bot behauptet deshalb nie, wie oft jemand geboostet hat.

## Ereignisstrategie

1. **Systemnachricht** → Ereignis mit Schlüssel `msg:<Nachrichten-ID>` (UNIQUE in SQLite), sofort fällig.
2. **Member-Update** mit neuem `premium_since` → Ereignis `premium:<Nutzer>:<Zeitpunkt>`. Es ist erst nach 20 Sekunden fällig, damit eine gleichzeitige Systemnachricht zuerst verarbeitet werden kann. Es zählt nur, wenn `premium_since` höchstens 15 Minuten alt ist.
3. **Verarbeitung** läuft seriell (eine Sperre). Ereignisse derselben Person innerhalb von 10 Minuten werden zu **einer** Danksagung zusammengeführt (`merged`). Eine ausstehende Systemnachricht hat Vorrang vor dem Member-Update.
4. **Veraltete Ereignisse** (älter als 15 Minuten plus Verzögerung) werden nicht mehr bedankt (`stale`).
5. **Danksagung** in 🎉・boost-danke: Erwähnt wird nur der Booster (`allowedMentions.users = [ID]`; abschaltbar mit `boost.mentionBooster`). Boost-Stufe und Anzahl erscheinen nur, wenn Discord sie liefert.

## Neustarts und Offline-Zeiten

- Beim Start gleicht der Bot alle Mitglieder ab und speichert ihren aktuellen Boost-Status **ohne** Danksagung.
- Mitglieder, deren `premium_since` nach dem letzten Heartbeat liegt, also während der Offline-Zeit mit dem Boosten begonnen haben, werden in ⚙️・bot-status **gemeldet, aber nicht automatisch bedankt**. Das Team kann manuell danken.
- Systemnachrichten und Member-Updates aus der Offline-Zeit liefert Discord nicht nach. Sie sind verloren. Das ist eine Discord-Eigenschaft, kein Fehler im Bot.
- Bereits verarbeitete Ereignisse sind dauerhaft gespeichert. Eine erneut zugestellte Systemnachricht (zum Beispiel nach einem Reconnect) führt nicht zu einer zweiten Danksagung.

## Booster-Rolle

| Modus | Verhalten |
|---|---|
| `managed` (empfohlen, sobald vorhanden) | Die von Discord verwaltete Booster-Rolle wird verwendet. Discord vergibt und entfernt sie selbst; der Bot verändert sie nie. |
| `custom` | Eigene kosmetische Rolle „Server Booster“. Wird vergeben, sobald `premium_since` gesetzt ist, und **nur** entfernt, wenn ein frischer REST-Abruf bestätigt, dass `premium_since` leer ist. Beim Ende gibt es keine öffentliche Nachricht. |

Existiert beim Setup schon eine verwaltete Booster-Rolle, verknüpft das Setup sie (Modus `managed`) und legt keine zweite an. Andernfalls legt es eine eigene Rolle an (Modus `custom`). Sobald Discord die verwaltete Rolle erstellt, meldet der Bot das in ⚙️・bot-status. Ein Founder kann dann mit `/serverboost rollenmodus modus:verwaltet` umstellen. Die alte eigene Rolle wird danach nicht mehr synchronisiert und kann manuell gelöscht werden.

## Befehle

- `/serverboost status`: Boost-Stufe, Anzahl, Intents, Systemkanal und -nachrichten, Rollenmodus, Ereignisstatistik, letzter Startabgleich, Grenzen
- `/serverboost sync`: Rollenabgleich der eigenen Rolle (nur im Modus `custom`)
- `/serverboost rollenmodus`: nur Founder

## Panel 💎・server-boosten

Das Panel erklärt, was ein Serverboost ist und wie man boostet (Servername → *Server boosten*). Es listet **nur tatsächlich eingerichtete** Vorteile: die Booster-Rolle (der Zusatz „separat angezeigt“ erscheint nur, wenn die Rolle das wirklich ist), die Danksagung und optionale, per `boost.extraPerks` eingetragene Vorteile. Für Konditionen und Preise verweist es auf die Discord-Hilfe.

Hinweis: Die Discord-Hilfeseite zum Boosten konnte in der Build-Umgebung nicht abgerufen werden. Die Bedienschritte im Panel sind bewusst allgemein formuliert und verweisen auf die offizielle Hilfe.
