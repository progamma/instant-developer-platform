# Instant Developer Cloud - framework setup

## ITA
1. [Versioni di riferimento](#versioni-di-riferimento)
1. [Installazione di Node.js](#installazione-di-nodejs)
1. [Installazione di pm2](#installazione-di-pm2)
1. [Installazione di Postgres 13](#installazione-di-postgres-13)
1. [Download del pacchetto da github e configurazione](#download-del-pacchetto-da-github-e-configurazione)
1. [Problemi noti](#problemi-noti)

### Versioni di riferimento
Il framework è verificato con le seguenti versioni dei componenti. Versioni diverse possono funzionare, ma non sono verificate.

| Componente | Versione di riferimento |
|------------|-------------------------|
| Node.js    | 22.23.4                 |
| npm        | 10.9.9 (quella inclusa in Node.js 22, da non aggiornare) |
| pm2        | 6.0.14                  |
| PostgreSQL | 13.20                   |
| pgvector   | 0.8.7                   |

### Installazione di Node.js
La versione di riferimento è [node.js](https://nodejs.org) v22.23. Per installare la versione si può far riferimento alla documentazione di Node.js, oppure seguire i seguenti passi se si tratta di ambiente Linux Ubuntu.
```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash
sudo apt-get install -y nodejs
```
Questi comandi installano l'ultima versione 22.x disponibile, che può essere più recente di quella di riferimento.

**Nota**:
Per versioni precedenti di Instant Developer Cloud si consiglia di utilizzare la tabella sottostante
| Versione framework | Versione Node consigliata |
|-------------------|---------------------------|
| 26.x              | 22                        |
| 25.x              | 22                        |
| 24.x              | 18                        |
| 22.x – 23.x       | 16                        |
| 21.x              | 12                        |
| 19.x – 20.x       | 10                        |
| < 19              | 6                         |


### Installazione di pm2
Per installare pm2 si usa la versione di npm inclusa in Node.js, senza aggiornarla (vedi [Problemi noti](#problemi-noti)).
```
sudo npm install pm2@6.0.14 -g
```
Se npm propone di aggiornarsi a una nuova versione maggiore (ad esempio la 12), il suggerimento va ignorato.

Il server cerca npm in */usr/local/bin*. Con Node.js installato da NodeSource npm si trova invece in */usr/bin*, quindi va creato il collegamento (vedi [Problemi noti](#problemi-noti)):
```
sudo ln -s /usr/bin/npm /usr/local/bin/npm
```

### Installazione di Postgres 13
1. installazione di Postgres
```
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt/ $(lsb_release -sc)-pgdg main" > /etc/apt/sources.list.d/PostgreSQL.list'
sudo apt-get -y update
sudo apt-get install postgresql-13 postgresql-13-pgvector
```
apt installa l'ultima versione 13.x disponibile, che può essere più recente di quella di riferimento.

Il pacchetto *postgresql-13-pgvector* è necessario dalla versione 25.5 del framework: il server crea l'estensione *vector* in ogni nuovo database e, se il pacchetto manca, l'installazione delle applicazioni con database fallisce.

Su Ubuntu 26.04 il comando *apt-key* non esiste più: vedi [Problemi noti](#problemi-noti).

È necessario configurare le credenziali per l'utente che accederà al database, che dovranno essere riportate nel file di configurazione config.json (dbUser e dbPassword). Ad esempio, per impostare la password dell'utente *postgres*:
```
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'password'"
```

### Download del pacchetto da github e configurazione
Per il download del pacchetto su linux da riga di comando è possibile usare 
```
wget https://github.com/progamma/instant-developer-platform/archive/master.zip
```
Dopodiché è necessario:
1. decomprimere la cartella sull'hd. In questa guida si prenderà in considerazione l'installazione in root.
1. rinominare *instant-developer-platform-master* in *idcloud*.
1. rinominare e spostare *public_html* in *idcloud/idserver*.
1. rimuovere *idcloud/nbproject*
1. creare le cartelle *idcloud/config*, *idcloud/idserver/apps/apps*, *idcloud/idserver/apps/db*, *idcloud/idserver/apps/backups*, *idcloud/idserver/node_modules*, *idcloud/idserver/log*
1. copiare *config-examples.json* in *idcloud/config/config.json*
1. editare *idcloud/config/config.json*
  1. *appDirectory* = */idcloud/idserver/apps*
  1. *alias* = *lista di ip o domini del server separati da ,*
  1. *dbUser* = *postgres username*
  1. *dbPassword* = *postgres password*
1. [Aggiornare i node modules](#aggiornare-i-node-modules)
1. [Aggiungere l'utente e il gruppo indert](#aggiungere-utente-e-gruppo-indert)
1. dare i permessi di scrittura a *postgres* su *idcloud/idserver/apps/db* - vedi [Postgres e permessi](#postgres-e-permessi)
1. [Avviare server.js con PM2](#avviare-serverjs-con-pm2)
 
#### Postgres e permessi
```
sudo chown postgres:postgres /idcloud/idserver/apps/db
sudo chmod 700 /idcloud/idserver/apps/db
```
#### Aggiornare i node modules
Alla prima installazione e per tutti i nuovi aggiornamenti è necessario aggiornare i pacchetti node modules per allinearli alla definizione contenuta in *package.json*.
Andare in *idcloud/idserver* e lanciare

```
cd /idcloud/idserver
sudo npm install
```

#### In caso di errori nell'aggiornamento
In caso di errori nell'aggiornamento tramite il comando *npm install* è necessario procedere con l'installazione manuale dei pacchetti che falliscono l'aggiornamento, cercando di risolvere i problemi uno per uno. Vedi anche [Problemi noti](#problemi-noti).

#### Aggiungere utente e gruppo indert
```
sudo useradd -m -s /bin/bash indert
sudo chown -R indert:indert /idcloud
sudo chmod -R 755 /idcloud
```
#### Avviare server.js con PM2
Per avviare server.js con PM2 e impostare il reboot automatico eseguire i comandi:
```
cd /idcloud/idserver/server
sudo pm2 start inde.json
sudo pm2 save
sudo pm2 startup ubuntu
```
#### Installazione manuale di una build
È possibile scaricare una build da Instant Developer Cloud e installarla sulla propria piattaforma

1. scaricare la build e decomprimerla in *idcloud/idserver/apps/apps/app-name*
1. editare *idcloud/config/config.json*
  1. *apps* = *[{ "cl" : "Node.App", "name" : "app-name", "date" : "current-date in ISO string", "stopped" : false}]*

#### Attivare la Server Session per una applicazione
Per attivare la server session è necessario editare *idcloud/config/config.json* impostando a true la proprietà *startSS* dei parametri dell'applicazione.
```
{ 
  "cl" : "Node.App",
  "name" : "app-name",
  "date" : "current-date in ISO string",
  "stopped" : false,
  "startSS": true
}
```
#### Gestione dei certificati
Per attivare il protocollo https ed utilizzare i propri certificati SSL sul server, è sufficiente
copiare i file sul server stesso e modificare opportunamente il file *idcloud/config/config.json*.

Ipotizzando che il server risponda all'indirizzo https://mysrv.mydomain.it sulla porta default
443 e che i file dei certificati siano stati copiati nella directory */idcloud/config/cert* il file
*idcloud/config/config.json* deve essere modificato nel seguente modo:
```
"domain": "mydomain.it",
"alias" : "mysrv.mydomain.it",
"protocol": "https",
"portHttps": 443,
"SSLCert": "/idcloud/config/cert/mydomain_it_certificate.crt",
"SSLKey": "/idcloud/config/cert/mydomain_it_private.key",
"SSLCABundles": [
"/idcloud/config/cert/mydomain_it_ca_bundle.crt"
],
```
È possibile aggiungere al file di configurazione la proprietà customSSLCerts per fare in
modo di utilizzare uno specifico certificato a seconda della URL di destinazione del server.

Se ad esempio il server è configurato, tramite DNS, a rispondere anche all’indirizzo
https://mysrv.myotherdomain.it, modificando la proprietà alias ed aggiungendo
customSSLCerts è possibile utilizzare un diverso certificato se il server è stato raggiunto
utilizzando questo nome. Ad esempio:
```
“alias” : “mysrv.mydomain.it, mysrv.myotherdomain.it”,
…
"customSSLCerts": [{
  "SSLDomain": "myotherdomain.it",
  "SSLCert": "/idcloud/config/cert/myotherdomain_it_certificate.crt",
  "SSLKey": "/idcloud/config/cert/myotherdomain_it_private.key",
  "SSLCABundles": [
  "/idcloud/config/cert/myotherdomain_it_ca_bundle.crt"
]
}],
```
#### Impostare l'applicazione di default
È possibile impostare quale applicazione deve essere eseguita impostando nel file *idcloud/config/config.json* la proprietà *alias* aggiungendo il nome dell'applicazione al nome del dominio o indirizzo ip preceduta dal carattere '|'.
Ad esempio:
```
"alias" : "mysrv.mydomain.it|app-name"
```
#### Configurazione dei processi worker per le applicazioni
Per configurare i valori di default per i worker delle applicazioni installate, è necessario
modificare il file config.json aggiungendo i valori desiderati per le proprietà **maxAppUsers**,
**minAppUsersPerWorker** e **maxAppWorkers**, come nel seguente esempio:
```
"maxAppUsers": 1000,
"minAppUsersPerWorker": 50,
"maxAppWorkers": 4,
```
Specificando il maxAppUsers è possibile definire il numero di processi worker che verranno creati dal server per gestire le sessioni di ogni
applicazione.

minAppUsersPerWorker indica qual è il numero di sessioni che ogni worker gestirà prima che venga avviato un nuovo processo che prenda in carico nuove sessioni client. 

maxAppWorkers indica il numero massimo di sessioni gestite contemporaneamente da un’applicazione prima che questa rifiuti l'avvio di una nuova
sessione.

In questo caso il valore tiene conto della somma di tutte le sessioni dei worker della stessa app.

### Problemi noti
#### apt-key non disponibile (Ubuntu 26.04)
Sulle versioni di Ubuntu con apt 3, come la 26.04, il comando *apt-key* non esiste più e il primo comando dell'[installazione di Postgres](#installazione-di-postgres-13) fallisce con *apt-key: command not found*. Se si prosegue, *apt-get update* scarta il repository con l'errore *NO_PUBKEY 7FCC7D46ACCC4CF8* e *postgresql-13* risulta non disponibile.

In questo caso la chiave va salvata in un file e indicata nel repository con *signed-by*, al posto dei primi due comandi:
```
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -sc)-pgdg main" > /etc/apt/sources.list.d/PostgreSQL.list'
```

#### npm aggiornato all'ultima versione
Con npm 12 o successivo *npm install* non funziona come previsto:
- si interrompe con l'errore *EALLOWREMOTE* sul pacchetto *xlsx*, che viene scaricato da un indirizzo esterno al registry npm;
- non esegue gli script di installazione dei pacchetti e lo segnala solo con l'avviso *install-scripts blocked*. I moduli nativi (ad esempio *canvas*, *sqlite3*, *odbc*, *oracledb*) restano senza binario e le applicazioni che li usano falliscono con errori come *Could not locate the bindings file*.

Per evitarlo va usata la versione di npm inclusa in Node.js 22 (vedi [Versioni di riferimento](#versioni-di-riferimento)). Se npm è già stato aggiornato, si può tornare a quella versione con *sudo npm install npm@10.9.9 -g*.

#### Estensione vector non disponibile
Se l'installazione di un'applicazione con database fallisce e nel log del server compare *extension "vector" is not available*, manca il pacchetto *postgresql-13-pgvector* (vedi [Installazione di Postgres 13](#installazione-di-postgres-13)).

#### Pacchetti npm personalizzati non installati
Se l'installazione di un pacchetto npm personalizzato dalla console fallisce e nel log compare *Error while executing NPM UPDATE: [object Object]*, il server non trova npm in */usr/local/bin*. Con Node.js installato da NodeSource npm si trova in */usr/bin*. Creare il collegamento:
```
sudo ln -s /usr/bin/npm /usr/local/bin/npm
```

### Nota Bene
L’accesso al Servizio di Supporto Tecnico non è consentito per richieste di supporto relative a problematiche riguardanti la pubblicazione su server manuale.

> [!IMPORTANT]
> ### Limitazioni
> I server Self Managed sono soggetti alle seguenti limitazioni:
> - Non possono ospitare il servizio Cloud Connector.
> - Non possono ospitare il servizio Analytics e Feedback.
> - Non possono ospitare il servizio di sincronizzazione dei database locali delle applicazioni. È invece possibile utilizzare l’accesso ai dati del server tramite Document Orientation Remota.
> - Non supportano l'installazione delle applicazioni e l'aggiornamento dei database dalla Console di Instant Developer Cloud


> [!NOTE]
> ### MyCloud
> Per l'installazione di un server di tipo MyCloud è possibile consultare la guida riportata nel capitolo **I server MyCloud** del manuale [17-I server di produzione](https://storage.googleapis.com/inde-downloads/doc/17-I%20server%20di%20produzione.pdf) disponibile dalla Console di Instant Developer Cloud.

