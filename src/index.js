import axios from "axios";
import _debug from "debug";
import { EventEmitter2 } from "eventemitter2";
import URL from "url-parse";
require("babel-polyfill");

const debug = {
  log: _debug("superlogin:log"),
  info: _debug("superlogin:info"),
  warn: _debug("superlogin:warn"),
  error: _debug("superlogin:error")
};

// Capitalizes the first letter of a string
function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function parseHostFromUrl(url) {
  const parsedURL = new URL(url);
  return parsedURL.host;
}

function checkEndpoint(url, endpoints) {
  const host = parseHostFromUrl(url);
  return !!~endpoints.indexOf(host);
}
function isStorageAvailable() {
  const mod = "__STORAGE__";
  try {
    localStorage.setItem(mod, mod);
    localStorage.removeItem(mod);
    return true;
  }
  catch (e) {
    return false;
  }
}

function parseError(err) {
  // if no connection can be established we don't have any data thus we need to forward the original error.
  if (err && err.response && err.response.data) {
    return err.response.data;
  }
  return err;
}

const memoryStorage = {
  setItem: (key, value) => {
    memoryStorage.storage.set(key, value);
  },
  getItem: key => {
    const value = memoryStorage.storage.get(key);
    if (typeof value !== "undefined") {
      return value;
    }
    return null;
  },
  removeItem: key => {
    memoryStorage.storage.delete(key);
  },
  storage: new Map()
};

class Superlogin extends EventEmitter2 {
  constructor() {
    super();

    this._oauthComplete = false;
    this._config = {};
    this._refreshInProgress = false;
    this._http = axios.create();
  }

  configure(config = {}) {
    if (config.serverUrl) {
      this._http = axios.create({
        baseURL: config.serverUrl,
        timeout: config.timeout
      });
    }

    config.baseUrl = config.baseUrl || "/auth";
    config.baseUrl = config.baseUrl.replace(/\/$/, ""); // remove trailing /
    config.socialUrl = config.socialUrl || config.baseUrl;
    config.socialUrl = config.socialUrl.replace(/\/$/, ""); // remove trailing /
    config.local = config.local || {};
    config.local.usernameField = config.local.usernameField || "username";
    config.local.passwordField = config.local.passwordField || "password";

    if (!config.endpoints || !(config.endpoints instanceof Array)) {
      config.endpoints = [];
    }
    if (!config.noDefaultEndpoint) {
      let defaultEndpoint = window.location.host;
      if (config.serverUrl) {
        defaultEndpoint = parseHostFromUrl(config.serverUrl);
      }
      if (!~config.endpoints.indexOf(defaultEndpoint)) {
        config.endpoints.push(defaultEndpoint);
      }
    }
    config.providers = config.providers || [];
    config.timeout = config.timeout || 0;

    if (!isStorageAvailable()) {
      this.storage = memoryStorage;
    }
    else if (config.storage === "session") {
      this.storage = window.sessionStorage;
    }
    else {
      this.storage = window.localStorage;
    }

    this._config = config;

    // Setup the new session
    this._session = JSON.parse(this.storage.getItem("superlogin.session"));

    this._httpInterceptor();

    // Check expired
    if (config.checkExpired) {
      this.checkExpired();
      this.validateSession()
        .then(() => {
          this._onLogin(this._session);
        })
        .catch(() => {
          // ignoring
        });
    }
  }

  _httpInterceptor() {
    const request = req => {
      const config = this.getConfig();
      const session = this.getSession();
      if (!session || !session.token) {
        return Promise.resolve(req);
      }

      if (req.skipRefresh) {
        return Promise.resolve(req);
      }

      return this.checkRefresh().then(() => {
        if (checkEndpoint(new URL(req.url, req.baseURL), config.endpoints)) {
          if (!req.headers.Authorization) {
            req.headers.Authorization = `Bearer ${session.token}`;
          }
        }
        return req;
      });
    };

    const responseError = error => {
      const config = this.getConfig();

      // if there is not config obj in in the error it means we cannot check the endpoints.
      // This happens for example if there is no connection at all because axion just forwards the raw error.
      if (!error || !error.config) {
        return Promise.reject(error);
      }

      // If there is an unauthorized error from one of our endpoints and we are logged in...
      if (checkEndpoint(error.config.url, config.endpoints) &&
      error.response && error.response.status === 401 && this.authenticated()) {
        debug.warn("Not authorized");
        this._onLogout("Session expired");
      }
      return Promise.reject(error);
    };
    // clear interceptors from a previous configure call
    this._http.interceptors.request.eject(this._httpRequestInterceptor);
    this._http.interceptors.response.eject(this._httpResponseInterceptor);

    this._httpRequestInterceptor = this._http.interceptors.request.use(request.bind(this));
    this._httpResponseInterceptor = this._http.interceptors.response.use(null, responseError.bind(this));
  }

  authenticated() {
    return !!(this._session && this._session.user_id);
  }

  getConfig() {
    return this._config;
  }

  async validateSession() {
    if (!this.authenticated()) {
      throw new Error("User is not authenticated");
    }
    if (this._session.expires > Date.now()) {
      return true;
    }
    else {
      try {
        await this.refresh();
      }
      catch (err) {
        this._onLogout("Session expired");
        throw parseError(err);
      }
    }
  }

  getSession() {
    if (!this._session) {
      this._session = JSON.parse(this.storage.getItem("superlogin.session"));
    }
    if (this._session && !this._session.refreshToken) {
      this._session.refreshToken = this.storage.getItem("superlogin.refreshToken");
    }
    return this._session ? Object.assign(this._session) : null;
  }

  setSession(session) {
    this._session = session;
    if (this._session.refreshToken) {
      this.storage.setItem("superlogin.refreshToken", this._session.refreshToken);
    }
    this.storage.setItem("superlogin.session", JSON.stringify(this._session));
    debug.info("New session set");
  }

  deleteSession() {
    this.storage.removeItem("superlogin.session");
    this.storage.removeItem("superlogin.refreshToken");
    this._session = null;
  }

  getDbUrl(dbName) {
    if (this._session.userDBs && this._session.userDBs[dbName]) {
      return this._session.userDBs[dbName];
    }
    return null;
  }

  getHttp() {
    return this._http;
  }

  confirmRole(role) {
    if (!this._session || !this._session.roles || !this._session.roles.length) return false;
    return this._session.roles.indexOf(role) !== -1;
  }

  confirmAnyRole(roles) {
    if (!this._session || !this._session.roles || !this._session.roles.length) return false;
    for (let i = 0; i < roles.length; i += 1) {
      if (this._session.roles.indexOf(roles[i]) !== -1) return true;
    }
    return false;
  }

  confirmAllRoles(roles) {
    if (!this._session || !this._session.roles || !this._session.roles.length) return false;
    for (let i = 0; i < roles.length; i += 1) {
      if (this._session.roles.indexOf(roles[i]) === -1) return false;
    }
    return true;
  }

  checkRefresh() {
    // Get out if we are not authenticated or a refresh is already in progress
    if (this._refreshInProgress) {
      return Promise.resolve();
    }
    if (!this._session || !this._session.user_id) {
      return Promise.reject(new Error({ "error": "User is not authenticated" }));
    }
    // try getting the latest refresh date, if not available fall back to issued date
    const refreshed = this._session.refreshed || this._session.issued;
    const expires = this._session.expires;
    const threshold = isNaN(this._config.refreshThreshold) ? 0.5 : this._config.refreshThreshold;
    const duration = expires - refreshed;
    let timeDiff = this._session.serverTimeDiff || 0;
    if (Math.abs(timeDiff) < 5000) {
      timeDiff = 0;
    }
    const estimatedServerTime = Date.now() + timeDiff;
    const elapsed = estimatedServerTime - refreshed;
    const ratio = elapsed / duration;
    if (ratio > threshold) {
      debug.info("Refreshing session");
      return this.refresh().then(session => {
        debug.log("Refreshing session sucess", session);
        return session;
      }).catch(err => {
        debug.error("Refreshing session failed", err);
        throw err;
      });
    }
    return Promise.resolve();
  }

  checkExpired() {
    // This is not necessary if we are not authenticated
    if (!this.authenticated()) {
      return;
    }
    const expires = this._session.expires;
    let timeDiff = this._session.serverTimeDiff || 0;
    // Only compensate for time difference if it is greater than 5 seconds
    if (Math.abs(timeDiff) < 5000) {
      timeDiff = 0;
    }
    const estimatedServerTime = Date.now() + timeDiff;
    if (estimatedServerTime > expires) {
      // try to refresh session using the refresh token
      this.refresh().catch(() => {
        this._onLogout("Session expired");
      });
    }
  }

  async refresh() {
    const session = this.getSession();
    this._refreshInProgress = true;
    const options = {};
    let res;
    if (session.expires < (Date.now() + 1000 * 60) && session.refreshToken) {
      // access token is expired or nearly expired
      // we'll have to use the refresh token
      console.log("access token expired, using refresh token");
      options["headers"] = {
        Authorization: `Bearer ${session.refreshToken}`
      };
    }
    try {
      res = await this._http.post(`${this._config.baseUrl}/refresh`, {}, options);
    }
    catch (err) {
      this._refreshInProgress = false;
      throw parseError(err);
    }
    this._refreshInProgress = false;
    if (res.data.token && res.data.expires) {
      Object.assign(session, res.data);
      this.setSession(session);
      this._onRefresh(session);
    }
    return session;
  }

  authenticate() {
    return new Promise(resolve => {
      const session = this.getSession();
      if (session) {
        resolve(session);
      }
      else {
        this.on("login", newSession => {
          resolve(newSession);
        });
      }
    });
  }

  async login(credentials) {
    const { usernameField, passwordField } = this._config.local;
    if (!credentials[usernameField] || !credentials[passwordField]) {
      throw new Error("Username or Password missing...");
    }
    let res;
    try {
      res = await this._http.post(
        `${this._config.baseUrl}/login`,
        credentials, {
          skipRefresh: true
        }
      );
    }
    catch (err) {
      this.deleteSession();
      throw parseError(err);
    }
    res.data.serverTimeDiff = res.data.issued - Date.now();
    this.setSession(res.data);
    this._onLogin(res.data);
    return res.data;
  }

  async register(registration) {
    let res;
    try {
      res = await this._http.post(
        `${this._config.baseUrl}/register`,
        registration, {
          skipRefresh: true
        }
      );
    }
    catch (err) {
      throw parseError(err);
    }
    if (res.data.user_id && res.data.token) {
      res.data.serverTimeDiff = res.data.issued - Date.now();
      this.setSession(res.data);
      this._onLogin(res.data);
    }
    this._onRegister(registration);
    return res.data;
  }

  async logout(msg) {
    const session = this.getSession();
    if (!session.dbUser) {
      // We are only using JWTs, so the user has to delete the token locally
      this._onLogout(msg || "Logged out");
      return;
    }
    let res;
    try {
      res = await this._http.post(`${this._config.baseUrl}/logout`, {});
    }
    catch (err) {
      this._onLogout(msg || "Logged out");
      if (!err.response || err.response.data.status !== 401) {
        throw parseError(err);
      }
      return;
    }
    this._onLogout(msg || "Logged out");
    return res.data;
  }

  async logoutAll(msg) {
    const session = this.getSession();
    if (!session.dbUser) {
      // We are only using JWTs, so the user has to delete the token locally
      this._onLogout(msg || "Logged out");
      return;
    }
    let res;
    try {
      res = await this._http.post(`${this._config.baseUrl}/logout-all`, {});
    }
    catch (err) {
      this._onLogout(msg || "Logged out");
      if (!err.response || err.response.data.status !== 401) {
        throw parseError(err);
      }
      return;
    }
    this._onLogout(msg || "Logged out");
    return res.data;
  }

  logoutOthers() {
    return this._http.post(`${this._config.baseUrl}/logout-others`, {})
      .then(res => res.data)
      .catch(err => {
        throw parseError(err);
      });
  }

  socialAuth(provider) {
    const providers = this._config.providers;
    if (providers.indexOf(provider) === -1) {
      return Promise.reject(new Error({ error: `Provider ${provider} not supported.` }));
    }
    const url = `${this._config.socialUrl}/${provider}`;
    return this._oAuthPopup(url, { windowTitle: `Login with ${capitalizeFirstLetter(provider)}` });
  }

  tokenSocialAuth(provider, accessToken) {
    const providers = this._config.providers;
    if (providers.indexOf(provider) === -1) {
      return Promise.reject(new Error({ error: `Provider ${provider} not supported.` }));
    }
    return this._http.post(`${this._config.baseUrl}/${provider}/token`, { access_token: accessToken })
      .then(res => {
        if (res.data.user_id && res.data.token) {
          res.data.serverTimeDiff = res.data.issued - Date.now();
          this.setSession(res.data);
          this._onLogin(res.data);
        }
        return res.data;
      })
      .catch(err => {
        throw parseError(err);
      });
  }

  tokenLink(provider, accessToken) {
    const providers = this._config.providers;
    if (providers.indexOf(provider) === -1) {
      return Promise.reject(new Error({ error: `Provider ${provider} not supported.` }));
    }
    const linkURL = `${this._config.baseUrl}/link/${provider}/token`;
    return this._http.post(linkURL, { access_token: accessToken })
      .then(res => res.data)
      .catch(err => {
        throw parseError(err);
      });
  }

  link(provider) {
    const providers = this._config.providers;
    if (providers.indexOf(provider) === -1) {
      return Promise.reject(new Error({ error: `Provider ${provider} not supported.` }));
    }
    if (this.authenticated()) {
      const session = this.getSession();
      const token = `bearer_token=${session.token}:${session.password}`;
      const linkURL = `${this._config.socialUrl}/link/${provider}?${token}`;
      const windowTitle = `Link your account to ${capitalizeFirstLetter(provider)}`;
      return this._oAuthPopup(linkURL, { windowTitle });
    }
    return Promise.reject(new Error({ error: "Authentication required" }));
  }

  unlink(provider) {
    const providers = this._config.providers;
    if (providers.indexOf(provider) === -1) {
      return Promise.reject(new Error({ error: `Provider ${provider} not supported.` }));
    }
    if (this.authenticated()) {
      return this._http.post(`${this._config.baseUrl}/unlink/${provider}`)
        .then(res => res.data)
        .catch(err => {
          throw parseError(err);
        });
    }
    return Promise.reject(new Error({ error: "Authentication required" }));
  }

  confirmEmail(token) {
    if (!token || typeof token !== "string") {
      return Promise.reject(new Error({ error: "Invalid token" }));
    }
    return this._http.get(`${this._config.baseUrl}/confirm-email/${token}`)
      .then(res => res.data)
      .catch(err => {
        throw parseError(err);
      });
  }

  forgotPassword(email) {
    return this._http.post(`${this._config.baseUrl}/forgot-password`, { email }, { skipRefresh: true })
      .then(res => res.data)
      .catch(err => {
        throw parseError(err);
      });
  }

  resetPassword(form) {
    return this._http.post(`${this._config.baseUrl}/password-reset`, form, { skipRefresh: true })
      .then(res => {
        if (res.data.user_id && res.data.token) {
          this.setSession(res.data);
          this._onLogin(res.data);
        }
        return res.data;
      })
      .catch(err => {
        throw parseError(err);
      });
  }

  changePassword(form) {
    if (this.authenticated()) {
      return this._http.post(`${this._config.baseUrl}/password-change`, form)
        .then(res => res.data)
        .catch(err => {
          throw parseError(err);
        });
    }
    return Promise.reject(new Error({ error: "Authentication required" }));
  }

  changeEmail(newEmail) {
    if (this.authenticated()) {
      return this._http.post(`${this._config.baseUrl}/change-email`, { newEmail })
        .then(res => res.data)
        .catch(err => {
          throw parseError(err);
        });
    }
    return Promise.reject(new Error({ error: "Authentication required" }));
  }

  validateUsername(username) {
    return this._http.get(`${this._config.baseUrl}/validate-username/${encodeURIComponent(username)}`)
      .then(() => true)
      .catch(err => {
        throw parseError(err);
      });
  }

  validateEmail(email) {
    return this._http.get(`${this._config.baseUrl}/validate-email/${encodeURIComponent(email)}`)
      .then(() => true)
      .catch(err => {
        throw parseError(err);
      });
  }

  _oAuthPopup(url, options) {
    return new Promise((resolve, reject) => {
      this._oauthComplete = false;
      options.windowName = options.windowTitle || "Social Login";
      options.windowOptions = options.windowOptions || "location=0,status=0,width=800,height=600";
      const _oauthWindow = window.open(url, options.windowName, options.windowOptions);

      if (!_oauthWindow) {
        reject(new Error({ error: "Authorization popup blocked" }));
      }

      const _oauthInterval = setInterval(() => {
        if (_oauthWindow.closed) {
          clearInterval(_oauthInterval);
          if (!this._oauthComplete) {
            this.authComplete = true;
            reject(new Error({ error: "Authorization cancelled" }));
          }
        }
      }, 500);

      window.superlogin = {};
      window.superlogin.oauthSession = (error, session, link) => {
        if (!error && session) {
          session.serverTimeDiff = session.issued - Date.now();
          this.setSession(session);
          this._onLogin(session);
          return resolve(session);
        }
        else if (!error && link) {
          this._onLink(link);
          return resolve(`${capitalizeFirstLetter(link)} successfully linked.`);
        }
        this._oauthComplete = true;
        return reject(error);
      };
    });
  }

  _onLogin(msg) {
    debug.info("Login", msg);
    this.emit("login", msg);
  }

  _onLogout(msg) {
    this.deleteSession();
    debug.info("Logout", msg);
    this.emit("logout", msg);
  }

  _onLink(msg) {
    debug.info("Link", msg);
    this.emit("link", msg);
  }

  _onRegister(msg) {
    debug.info("Register", msg);
    this.emit("register", msg);
  }

  _onRefresh(msg) {
    debug.info("Refresh", msg);
    this.emit("refresh", msg);
  }
}

export default new Superlogin();
