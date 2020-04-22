### Instant Developer Cloud - framework setup

## ITA
1. [Installazione di Node.js](#installazione-di-nodejs)
1. [Installazione di npm](#installazione-di-npm)
1. [Installazione di Postgres 10](#installazione-di-postgres-10)
1. [Download del pacchetto da github e configurazione](#download-del-pacchetto-da-github-e-configurazione)

## Installazione di Node.js
La versione di riferimento è Node.js 10.18.1. Per installare la versione si può far riferimento alla documentazione di Node.js, oppure seguire i seguenti passi se si tratta di ambiente Linux Ubuntu.

> curl -sL https://deb.nodesource.com/setup_10.x | sudo bash

> sudo apt-get install -y nodejs

## Installazione di npm
Per installare pm2 è consigliabile aggiornare prima la versione di npm

> npm install npm@latest -g

e poi installare pm2

> npm install pm2 -g

## Installazione di Postgres 10
1. installazione di Postgres

> wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
> sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt/ $(lsb_release -sc)-pgdg main" > /etc/apt/sources.list.d/PostgreSQL.list'
> apt-get -y update
> apt-get install postgresql-10

## Download del pacchetto da github e configurazione
Per il download del pacchetto su linux da riga di comando è possibile usare 

> wget https://github.com/progamma/inde-self/archive/master.zip

Dopodiché è necessario:
1. decomprimere la cartella sull'hd. In questa guida si prenderà in considerazione l'installazione in root.
1. rinominare *inde-self-master* in *idcloud*.
1. rinominare e spostare *public-html* in *idcloud/idserver*.
1. rimuovere *idcloud/nbproject*
1. creare le cartelle *idcloud/config*, *idcloud/idserver/apps/apps*, *idcloud/idserver/apps/db*, *idcloud/idserver/apps/backups*, *idcloud/node_modules*, *idcloud/idserver/log*
1. copiare *config-example.json* in *idcloud/config/config.json*
1. editare *idcloud/config/config.json*
  1. *appDirectory* = */idcloud/idserver/apps*
  1. *dbUser* = *<postgres username>*
  1. *dbPassword* = *<postgres password>*
  1. *dbUser* = *<postgres username>*
1. [Aggiornare i node modules](#aggiornare-i-node-modules)
1. [Aggiungere l'utente e il gruppo indert](#aggiungere-utente-e-gruppo-indert)
1. dare i permessi di scrittura a *postgres* su *idclous/apps/db* - vedi [#Postgres e permessi](Postgres e permessi)
1. creare un database postgress di nome *root*
1. [Avviare server.js con PM2](#avviare-serverjs-con-pm2)
 
### Postgres e permessi
> chown postgres:postgres /idcloud/idserver/apps/db
> chmod 700 /idcloud/idserver/apps/db

## Aggiornare i node modules
Alla prima installazione e per tutti i nuovi aggiornamenti è necessari aggiornare i pacchetti node modules per allinearli alla definizione contenuta in *package.json*.
Andare in *idcloud/idserver* e lanciare

> cd /idcloud/idserver
> npm install

## Aggiungere utente e gruppo indert

> sudo adduser indert
> sudo chown -R indert:indert /idcloud
> sudo chmod -R 755 /idcloud

## Avviare server.js con PM2
Per avviare server.js con PM2 e impostare il reboot automatico eseguire i comandi:

> cd /idcloud/idserver/server
> pm2 start server.js
> pm2 save
> pm2 startup ubuntu

## Installazione manuale di una build
È possibile scaricare una build da Instant Developer Cloud e installarla sulla propria piattaforma

1. scaricare la build e decoprimerla in *idcloud/apps/apps/<app-name>*
1. editare *idcloud/config/config.json*
  1. *apps* = *[{ "cl" : "Node.App", "name" : "<app-name>", "date" : "<current-date in ISO string>", "stopped" : false}]*
