---
name: priority-write
description: Turn a plumber's Hebrew order message into a draft Priority sales order (customer, project, parts and quantities) and propose it for the owner's approval with priority-axi create.
metadata:
  comis.roles: "main"
  comis.pack: "apps"
  comis.requires.bins: "priority-axi"
  comis.requires.env: "PRIORITY_URL PRIORITY_PASSWORD"
  comis.requires.services: "priority"
---

Every create waits for the owner's approval of the exact request, and each
record and line uses one of the owner's paid API transactions. Run
`priority-axi create <SCREEN> --set F=V --line <SUB> F=V --dry-run`, check the
body, then run the printed command once. `priority-axi help create` and
`--help` only print; they send nothing. Set only the fields the owner or the
plumber gave; Priority fills the rest. When Priority refuses with
`priority_rejected`, its message says what is wrong, in Hebrew: ask for the
missing value. Never make up a value for a required field.

## A plumber's order message

Plumbers send short Hebrew messages, such as
`תזמין עבור פרוייקט אלפא הנדסה צינור 4״ pvc כתום שש יחידות של 4 מטר כל אחד`.
Turn each one into one draft sales order (ORDERS).

1. Project and customer. Search the site's own words, such as its name, street
   or lot number, with `priority-axi find DOCUMENTS_p <words>`, the projects
   screen. Each project carries its customer (CUSTNAME, CUSTDES), and the
   customer's name is searched too. When the message has no site words, search
   the customer words the same way.
   - A project fits only when the plumber's site words match its own name:
     find marks it `matched: own`. `matched: customer` (or `parent`) means some
     words matched only the customer's name, so it does not fit.
   - Exactly one fits: use its DOCNO and CUSTNAME.
   - None fits, or several do, or the message has no site words: ask for the
     site's name or lot number; the site also tells you the customer when the
     customer words match more than one. List the candidates by name, with
     DOCNO where two share a name, when there are five or fewer. Only if the
     plumber says there is no project, order on the customer without DOCNO;
     find it with `priority-axi find CUSTOMERS <words>` and ask which one when
     several fit.
   - find returns open projects only: `בעבודה` (in progress), `בשלבי סיום`
     (finishing) and `טיוטא` (draft) can all take orders.
   - find leaves out cancelled and finished projects. When it says
     `not_in_use`, the site the plumber named is closed: show it with `--all`,
     tell the plumber its status, and ask where to order instead. Never order
     for a closed project.
   - If the projects screen answers `screen_not_enabled`, search
     `priority-axi find CUSTOMERS --sub CUSTPROJECTS <words>` instead; it knows
     no project status. The home view's `screens_read` lists only the screens
     read so far, not every screen that is open.
   - Places are often shortened: ת"א is תל אביב, ר"ג is רמת גן, פ"ת is פתח
     תקווה, ק. is קריית. Search the distinctive word (אונו, בארט), not the
     abbreviation.
   - Never choose for the plumber.
2. Each item. Put the plumber's words into the catalog's words (below) and run
   `priority-axi find LOGPART <type> <use> <size>`, such as `צינור ביוב 110`,
   `ברך ביוב 110` or `צינור סק 40 4`.
   - Leave out the colour, finish, class, length and quantity, then read them
     from the descriptions found. Searching them too would hide the choices
     you must ask about.
   - Use singular word stems (ברך, not ברכיים). find matches a word at its
     start, after Hebrew prefix letters, so `ביוב` finds `לביוב`.
   - When more than one part still fits what the plumber wrote, ask, naming
     the choices.
3. Quantity. Read the part's unit (PUNITNAME) in the find answer.
   - `יח'`: pieces of the length in the description. TQUANT is the number of
     pieces.
   - `מטר`: metres. TQUANT is the total length in metres: the length the
     plumber gave ("10 מטר"), or the pieces times the length of each.
4. Ask in one message. Put every question in one message before the dry run:
   the site, the choices between parts, and any word you could not place, such
   as a stray letter. The confirmation in step 6 is a second message; a new
   question is needed only when an answer changes the search.
5. Draft. Check that the same order is not already there:
   `priority-axi get ORDERS --where CUSTNAME=<CUSTNAME> --where DOCNO=<DOCNO> --sort CURDATE:desc --limit 5`.
   No records is the usual answer. Orders still waiting for the owner are not in
   Priority yet: also check the orders you sent for approval in this
   conversation, and ask the plumber before sending the same items again. Then run the create with `--dry-run`:
   `priority-axi create ORDERS --set CUSTNAME=<CUSTNAME> --set DOCNO=<DOCNO> --set 'DETAILS=<plumber name>' --line ORDERITEMS PARTNAME=<PARTNAME> TQUANT=<n> --line ORDERSTEXT 'TEXT=<message> | <answers>' --dry-run`.
   - Add one `--line ORDERITEMS` per item. DETAILS holds at most 24 characters:
     the sender's name as the conversation shows it.
   - TEXT is the plumber's message exactly as sent, typos included, then ` | `
     and their answers to your questions, such as
     `| הבהרה: אתר אלפא הפניקס; ה-ת טעות הקלדה`. The owner sees both on the
     approval card.
   - These commands need no `priority-axi fields` first.
6. Confirm. Tell the plumber, in Hebrew, the customer, the project, and each
   part's description and quantity. After they agree, run the printed command
   once.

## The catalog's words for plumbing

- **PVC and polyethylene diameters are in millimetres.**
  - The catalog pairs inches and millimetres like this: 1½"=50, 2"=63, 2½"=75,
    3"=90, 4"=110, 5"=140, 6"=160, 8"=225, 10"=280, 12"=315.
  - For PVC, "4 צול", "4 אינץ'" and "4״" all mean 110.
  - Sewer pipes come in 110, 160, 200 and 250. When the inch size does not
    land on one of them (8" sewer), ask.
- **Steel pipes keep inches.**
  - Schedule pipe (סקדיול) is written `סק'` or `סק` with its schedule and inch
    size, such as `צינור סק' 40 ... 4"`. Search `צינור סק 40 4`.
  - Finishes:
    - `מג' צבוע לבן`: galvanized and painted white.
    - `מגולבן`: galvanized only. It comes `בלי תפר` (seamless), `עם תפר`
      (welded) or `שחול` (extruded).
    - `שחור`: black.
    - `מחורץ`: grooved, for grooved couplings.
  - A plumber's "לבן" can mean painted white or plain galvanized. Ask about the
    finish and plain or grooved in one message; ask about the seam only for a
    finish that comes in more than one seam (plain galvanized).
  - Most steel pipe is sold by the metre.
- **Lengths** are written as millimetres (`4000 מ"מ`), centimetres (`ס"מ`) or
  metres (`3 מ'`, `3 מטר`). "4 מטר" is the part whose description says
  4000 מ"מ or 4 מטר.
- **Sewer pipes.** The catalog has four kinds; the description names the kind
  and its ring stiffness class (SN4, or the stiffer SN8 for deep or loaded
  ground):
  - plain orange PVC (`כתום`, family צנרת PVC לביוב): SN4, 250 to 4000 mm;
  - structured wall (`מובנה`): SN4 or SN8, 3 m;
  - thick (`עבה`): SN8, 3 m;
  - ULTRA (its own family): SN4 in 1, 3 and 4 m, SN8 in 3 m.

  "כתום" or "pvc" from a plumber means the plain orange pipe; a 3 m plain pipe
  is written `SN4 רגיל` without the colour, and is the same pipe. Offer ULTRA,
  מובנה or עבה only when the plumber names one, names SN8, or the plain pipe
  does not come in the size and length asked: then ask which.
- **Fittings follow the pipe.** "כתום" on an elbow, sleeve or reducer means the
  plain orange sewer fittings (family אביזרים PVC לביוב), so search `ברך ביוב
  110`. Elbows come with or without an inspection opening (`ביקורת`); ask only
  when the plumber mentions one or both fit what they wrote.
- **find shows the catalog, not stock.** "מה שיש" from a plumber means the part
  the catalog has; say so if stock may matter.
- **Words:**

  | Hebrew | Meaning |
  | --- | --- |
  | צינור | pipe |
  | ביוב | sewer |
  | ברך | elbow |
  | ביקורת | inspection opening (עם/בלי ביקורת) |
  | מופה | socket |
  | שרוול | sleeve |
  | מעביר | reducer |
  | יח' or יחידות | pieces |
  | מ' or מטר | metres |
  | מ"מ | millimetres |
  | צול or אינץ' | inches |

## After the create

`held_for_approval` is not an error to fix, although it exits with 1 and prints
a usage line like every refusal. Never run the create again.
1. Run `comis action wait <id>` once.
2. Still pending: send the plumber one message saying the order waits for the
   owner's approval and that you will update them. Check again later, when
   they ask or when Comis reports the decision; do not poll.
3. Done: give the order number (ORDNAME). Read the order back with
   `priority-axi show ORDERS <ORDNAME>` and report its status (ORDSTATUSDES).
4. Refused by the owner: tell the plumber, with the owner's reason if given.

If Priority refuses because the order has no number, the message says
`חסר מס חוזה` or asks to run "הכנת תבניות מספר לתעודות". This means document
numbering is not set up in Priority. Tell the owner, and do not set ORDNAME
yourself.

Updating and deleting records are not available; say so and leave them to the
owner.
