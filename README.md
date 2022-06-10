### Instant Developer Cloud - framework setup

## ITA
1. [Installazione di Node.js](#installazione-di-nodejs)
1. [Installazione di npm](#installazione-di-npm)
1. [Installazione di Postgres 10](#installazione-di-postgres-10)
1. [Download del pacchetto da github e configurazione](#download-del-pacchetto-da-github-e-configurazione)

### Installazione di Node.js
La versione di riferimento è Node.js 12.18.0. Per installare la versione si può far riferimento alla documentazione di Node.js, oppure seguire i seguenti passi se si tratta di ambiente Linux Ubuntu.

> curl -sL https://deb.nodesource.com/setup_12.x | sudo bash

> sudo apt-get install -y nodejs

### Installazione di npm
Per installare pm2 è consigliabile aggiornare prima la versione di npm

> npm install npm@latest -g

e poi installare pm2

> npm install pm2 -g

### Installazione di Postgres 10
1. installazione di Postgres

> wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
> sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt/ $(lsb_release -sc)-pgdg main" > /etc/apt/sources.list.d/PostgreSQL.list'
> apt-get -y update
> apt-get install postgresql-10

### Download del pacchetto da github e configurazione
Per il download del pacchetto su linux da riga di comando è possibile usare 

> wget https://github.com/progamma/instant-developer-platform/archive/master.zip

Dopodiché è necessario:
1. decomprimere la cartella sull'hd. In questa guida si prenderà in considerazione l'installazione in root.
1. rinominare *instant-developer-platform-master* in *idcloud*.
1. rinominare e spostare *public-html* in *idcloud/idserver*.
1. rimuovere *idcloud/nbproject*
1. creare le cartelle *idcloud/config*, *idcloud/idserver/apps/apps*, *idcloud/idserver/apps/db*, *idcloud/idserver/apps/backups*, *idcloud/node_modules*, *idcloud/idserver/log*
1. copiare *config-example.json* in *idcloud/config/config.json*
1. editare *idcloud/config/config.json*
  1. *appDirectory* = */idcloud/idserver/apps*
  1. *alias* = *lista di ip o domini del server separati da ,*
  1. *dbUser* = *postgres username*
  1. *dbPassword* = *postgres password*
  1. *dbUser* = *postgres username*
1. [Aggiornare i node modules](#aggiornare-i-node-modules)
1. [Aggiungere l'utente e il gruppo indert](#aggiungere-utente-e-gruppo-indert)
1. dare i permessi di scrittura a *postgres* su *idclous/apps/db* - vedi [#Postgres e permessi](Postgres e permessi)
1. creare un database postgress di nome *root*
1. [Avviare server.js con PM2](#avviare-serverjs-con-pm2)
 
#### Postgres e permessi
> chown postgres:postgres /idcloud/idserver/apps/db
> chmod 700 /idcloud/idserver/apps/db

#### Aggiornare i node modules
Alla prima installazione e per tutti i nuovi aggiornamenti è necessari aggiornare i pacchetti node modules per allinearli alla definizione contenuta in *package.json*.
Andare in *idcloud/idserver* e lanciare

> cd /idcloud/idserver
> npm install

#### In caso di errori nell'aggiornamento
In caso di errori nell'aggiornamento tramite il comando *npm install* è necessario procedere con l'installazione manuale dei pacchetti che falliscono l'aggiornamento, cercando di risolvere i problemi uno per uno. 

Di seguito alcuni problemi noti all'installazione di pacchetti specifici:
1. puppeteer@2.1.1 - alcune distribuzioni di linux dànno errore con l'installazione di puppeteer@2.1.1, dando errore *Error: EACCES: permission denied, mkdir '/idcloud/idserver/node_modules/puppeteer/.local-chromium'*. In questo caso una possibile soluzione è installarlo tramite il comando *sudo npm install puppeteer#2.1.1 --unsafe-perm=true*.

#### Aggiungere utente e gruppo indert

> sudo adduser indert
> sudo chown -R indert:indert /idcloud
> sudo chmod -R 755 /idcloud

#### Avviare server.js con PM2
Per avviare server.js con PM2 e impostare il reboot automatico eseguire i comandi:

> cd /idcloud/idserver/server
> pm2 start server.js
> pm2 save
> pm2 startup ubuntu

#### Installazione manuale di una build
È possibile scaricare una build da Instant Developer Cloud e installarla sulla propria piattaforma

1. scaricare la build e decoprimerla in *idcloud/apps/apps/app-name*
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
"domain": "mydomain.com",
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
