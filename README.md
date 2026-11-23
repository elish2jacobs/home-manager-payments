# Home Manager Payments — מדריך התקנה (שלב 1)

זמן משוער: 20–30 דקות, פעם אחת בלבד.
כתובת האתר בסוף התהליך: **https://elish2jacobs.github.io/home-manager-payments/**

הקבצים בתיקייה:

| קובץ | מה הוא |
|---|---|
| `index.html` | מבנה האפליקציה |
| `styles.css` | העיצוב |
| `app.js` | הלוגיקה: התחברות, Drive, Sheets, ניווט |
| `config.js` | ההגדרה היחידה שתערוך: ה-Client ID |
| `README.md` | המדריך הזה |

---

## חלק א׳ — GitHub (האתר)

**1. יצירת מאגר**
- היכנס ל-github.com עם המשתמש **Elish2jacobs**.
- למעלה מימין: **+** ← **New repository**.
- שם המאגר: `home-manager-payments` (בדיוק כך, באותיות קטנות).
- סמן **Public**. במסלול החינמי, GitHub Pages עובד רק עם מאגר ציבורי. הקוד יהיה גלוי, אבל אין בו שום סוד ושום נתון: הנתונים נשמרים ב-Drive של כל משתמש.
- לחץ **Create repository**.

**2. העלאת הקבצים**
- בעמוד המאגר: **Add file** ← **Upload files**.
- גרור את חמשת הקבצים. הקבצים צריכים לשבת ישירות במאגר, לא בתוך תיקייה.
- למטה: **Commit changes**.

**3. הפעלת האתר**
- במאגר: **Settings** ← בתפריט הצד **Pages**.
- תחת **Build and deployment**: בשדה Source בחר **Deploy from a branch**, בשדה Branch בחר **main** ואת התיקייה **/ (root)**, ולחץ **Save**.
- אחרי דקה או שתיים תופיע למעלה הכתובת של האתר. פתח אותה: אמור להופיע המסך **"חסרה הגדרה"**. זה תקין, נגיע לזה בחלק ב׳.

---

## חלק ב׳ — Google Cloud (ההתחברות)

**4. פתיחת פרויקט**
- היכנס ל-**console.cloud.google.com** עם חשבון ה-Gmail שלך.
- למעלה, בבורר הפרויקטים: **New Project**. שם: `Home Manager Payments`. לחץ **Create**, וודא שהפרויקט החדש נבחר למעלה.
- לא צריך כרטיס אשראי ולא צריך חשבון חיוב.

**5. הפעלת שני השירותים**
- בתפריט: **APIs & Services** ← **Library**.
- חפש **Google Drive API** ← **Enable**.
- חזור, חפש **Google Sheets API** ← **Enable**.

**6. מסך ההסכמה (מה שהמשתמשים רואים בכניסה הראשונה)**
- בתפריט: **Google Auth Platform**. בחלק מהחשבונות זה מופיע תחת **APIs & Services** ← **OAuth consent screen**. לחץ **Get started**.
- **App name:** `Home Manager Payments`. **User support email:** המייל שלך.
- **Audience:** בחר **External**.
- **Contact information:** המייל שלך. אשר את התנאים ולחץ **Create**.
- **Data Access** ← **Add or remove scopes**: סמן את `.../auth/drive.file`. אם הוא לא ברשימה, הדבק אותו בשדה הידני: `https://www.googleapis.com/auth/drive.file`. אחר כך **Update** ← **Save**.
- **Audience** ← **Test users** ← **Add users**: הוסף את כתובת ה-Gmail שלך ואת הכתובות של כל מי שישתמש במערכת, עד 100. רק מי שברשימה יוכל להתחבר.

**7. מפתח ההתחברות (Client ID)**
- **Clients** ← **Create client**.
- **Application type:** בחר **Web application**. **Name:** `Home Manager Payments Web`.
- **Authorized JavaScript origins** ← **Add URI**: הדבק בדיוק את `https://elish2jacobs.github.io`, בלי לוכסן בסוף ובלי שם המאגר.
- את **Authorized redirect URIs** השאר ריק.
- לחץ **Create** והעתק את ה-**Client ID**. הוא נראה כך: `1234567890-abcdefg.apps.googleusercontent.com`.

---

## חלק ג׳ — חיבור בין השניים

**8. הדבקת ה-Client ID**
- ב-GitHub, במאגר: פתח את `config.js` ← לחץ על סמל העיפרון (Edit).
- החלף את `PASTE_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com` ב-Client ID שהעתקת, ושמור על הגרשיים.
- **Commit changes**.
- המתן דקה או שתיים עד שהאתר יתעדכן.

**9. בדיקה**
- פתח את האתר בטלפון.
- לחץ **התחבר עם Google** ובחר את החשבון שלך.
- יופיע מסך **"Google hasn't verified this app"**. זה צפוי כל עוד האפליקציה במצב בדיקות. לחץ **Continue**.
- אשר את הגישה לקבצים, ולחץ **צור פרויקט**.
- בדוק ב-Google Drive: אמורה להופיע תיקייה **פרויקט הבית שלי**, ובתוכה 5 תיקיות משנה וקובץ **נתוני הבית**.
- בדשבורד לחץ **בצע בדיקה**. אמורה להופיע ההודעה "נשמר ונקרא בהצלחה מהגיליון".
- בונוס: היכנס מהמחשב עם אותו חשבון. אותו פרויקט אמור להיטען, ולא להיווצר פרויקט חדש.

**הוספה למסך הבית בטלפון:** באנדרואיד, ב-Chrome: ⋮ ← **הוסף למסך הבית**. באייפון, ב-Safari: כפתור השיתוף ← **הוסף למסך הבית**.

---

## אם משהו לא עובד

| מה רואים | מה לעשות |
|---|---|
| "חסרה הגדרה" | ה-Client ID לא הודבק ב-`config.js`, או שהאתר עוד לא התעדכן. המתן 2 דקות ורענן. |
| `Error 400: redirect_uri_mismatch` או `origin_mismatch` | הכתובת בשלב 7 לא מדויקת. חייב להיות `https://elish2jacobs.github.io` בדיוק. שינוי שם יכול לקחת כמה דקות להשפיע. |
| `Error 403: access_denied` | החשבון לא נוסף ל-Test users (שלב 6). |
| "הדפדפן חסם את חלון ההתחברות" | אפשר חלונות קופצים לאתר, או נסה דפדפן אחר. |
| "לא אושרה גישה ל-Google Drive" | בחלון ההרשאות צריך לסמן את התיבה של הגישה לקבצים. |
| כל דבר אחר | צלם מסך ושלח לי. |
