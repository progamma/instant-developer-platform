Self Managed Cloud Documentation
================================

Installing Node.js
----------------

Notice previous installations of Node.js or io.js could conflict with our setup.
We recommend to always install Node.js @6.2.1.

### Windows Server procedure

* Open https://nodejs.org/ in your browser.
* From the website, download Node.js@6.2.1 for Windows 32/64 depending on your hardware.
* Once download is completed, start the setup procedure. It is a standard Windows setup wizard. When asked to choose which components of Node.js to install, it is necessary to select *Node.js runtime*, *npm package manager*, and *add to Windows PATH*.
* Once the wizard finishes installing Node.js, you can verify the installation was successful by opening the Command Prompt, and executing `C:\>node -v`.

### Linux and BSD procedure

* Open https://nodejs.org/ in your browser. The website contains binary packages for Linux.
* Node.js should be also present in your OS official repositories. Please note that for Debian/Ubuntu distributions it is not suggested to use the official repositories as they conflict with an older package called `node` that has nothing to do with Node.js. Please note we don't endorse any non official source for Node.js.

Downloading the Instant Developer server
----------------------------------------

* Open https://github.com/progamma/inde-self in your browser.
* From the right sidebar, click the "Download ZIP" button.
* Create a working directory on your server, from now on referred to as `basedir`.
* Create a new folder `basedir/IDServer`
* Extract the downloaded zip file and extract it inside `basedir/IDServer`.
* Create a new folder `basedir/IDServer/node_modules`
* Create a new folder `basedir/IDServer/appDirectory`
* Create a new folder `basedir/IDServer/appDirectory/apps`

Directory structure
-------------------

The server's directories must have the following structure:

+ basedir
  + IDServer
    + appDirectory
      + apps - directory containing the installed apps
    + server - directory containing the server runtime
    + node_modules - directory containing the node.js dependences of `server`
  + config - directory containing the configuration file (config.json)
    
Configuring the Instant Developer server
----------------------------------------

The server is configured via the `config.json` file. An example can be found in `basedir/IDServer/server/config-example.json`.
When working in production, `basedir/config/config.json` is loaded.

The file is a JSON formatted object, with the following properties:

* cl: name of the server namespace, leave untouched.
* name: third level domain name of the server
* domain: second level domain name of the server
* defaultApp: name of the app to be loaded when browsing `name.domain`
* appDirectory: path to `basedir/appDirectory`
* portHttp: port number where the server listens to HTTP conections
* portHttps: port number where the server listens to HTTPS conections
* protocol: protocol used by the server, either "http" or "https"
* SSLCert: path to the SSL certificate for your domain
* SSLKey: path to the SSL key for your domain
* SSLCABundles: array of paths to the SSL Certificate Authority bundles
* dbAddress: address of the server's database
* dbPort: port of the server's database
* dbUser: database user assigned to Instant Developer
* dbPassword: password of the Instant Developeruser
* apps: array of JSON objects representing the installed apps. Refer to the *Installing your apps* section.

Configuring your firewall
-------------------------

By default Instant Developer server listens to HTTP connections on port 8081, and to HTTPS connections on 8082.
You may wish to configure your firewall to redirect ports 80 and 443 to the former.

Installing your apps (todo)
--------------------

Instant Developer apps are generated from the IDE console as `tar.gz` archives. The archive contains a directory named after the built application. From now on we refer to this directory as `appname`.
In order to install an application, follow the steps below:

* Download the application's archive from the Instant Developer console.
* Extract the archive as `basedir/appDirectory/apps/appname`.
* Add an object to the `apps` array in `config.json`, with the following properties:
  * cl: name of the application namespace, leave untouched
  * name: name of the directory containing the app, i.e. `appname`
  * version: version of the application
  * stopped: boolean value. If set to `true`, when browsing `name.domain/appname` the server will return error 503.

Your installed app will be running on `name.domain/appname`.

Launching the server
--------------------

In order to launch the server, execute `node basedir/master/master.js`.
For a more flexible setup, you may want to call `basedir/master/master.js` using a tool such as [PM2](https://github.com/Unitech/pm2).

Reading your logs
-----------------

All errors and warnings coming from the server are logged to `basedir/master/log/logs.log`.
Each line in the file is formatted as a JSON object.

Updating your server
--------------------

In order to update the server, simply fetch the latest version from GitHub, and decompress it in `basedir/master`.
