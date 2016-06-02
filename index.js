const config = require('./config');
const eventEmitter = new (require('events'))();
const moment = require('moment');
const unescape = require('lodash.unescape');

const log = (...args) => {
  if (process.env.NODE_ENV === 'development') {
    require('util').log(args);
  }
}

// IRCD {{{
const ircd = {
  send: (prefix, command, params = ['']) => {
    let msg = '';
    if (prefix) {
      msg += `:${prefix} `;
    } else {
      msg += `:tig.js `;
    }
    msg += `${command}`;
    for (const param of params) {
      if (param.includes(' ')) {
        msg += ` :${param}`;
      } else {
        msg += ` ${param}`;
      }
    }
    eventEmitter.emit('send', msg);
  },
  init: () => {
    ircd.server = require('net').createServer((connection) => {
      eventEmitter.on('send', (msg) => {
        log(`>> ${msg}`);
        connection.write(`${msg}\r\n`);
      });

      let nick, buffer = '';
      connection.on('data', (data) => {
        buffer += data;
        let lines = buffer.split('\r\n');
        buffer = lines.pop();

        for (const line of lines) {
          const [command, ...args] = line.split(' ');
          log('<< ', command, args);
          switch (command) {
            case 'NICK':
              nick = args[0];
              break;
            case 'USER':
              // client incoming
              ircd.send(null, '001', [nick, 'Welcome to tig.js']);
              ircd.send(`${args[0]}!${args[3]}@${connection.remoteAddress}`, 'JOIN', ['#timeline']);
              ircd.send(null, 'MODE', ['#timeline', '+mot', args[0]]);

              twitter.getLastStatus(args[0], (user) => {
                ircd.send(null, 'TOPIC', ['#timeline', user.status.text]);
              });

              eventEmitter.on('tweet', function (status) {
                if (connection.writable) {
                  const [name, text] = twitter.toReadable(status, nick);
                  if (name === nick) {
                    ircd.send(null, 'TOPIC', ['#timeline', text]);
                  } else {
                    ircd.send(name, 'PRIVMSG', ['#timeline', text]);
                  }
                } else {
                  log(this);
                  eventEmitter.removeListener('tweet', this._events.tweet[0]);
                }
              });
              break;
            case 'PRIVMSG':
              if (args[0] === '#timeline') {
                if (args[1] === ':\u0001ACTION') {
                  const action = args.slice(2).join(' ').replace('\u0001', '');
                  if (/r|reconnect/i.test(action)) {
                    twitter.reconnectCount = 0;
                    twitter.reconnect();
                  }
                } else {
                  const text = args.slice(1).join(' ').replace(/^:/, '');
                  twitter.oauth.post('https://api.twitter.com/1.1/statuses/update.json', config.accessToken, config.accessTokenSecret, { status: text }, (error, data, response) => {
                    if (error) { log(error); }
                  });
                }
              }
              break;
          }
        }
      });
      connection.on('error', (error) => {
        log(error);
      });
      connection.on('close', () => {
        // connection close
      });
    }).listen(process.env.PORT || 16668);
  }
}
ircd.init();
// }}}

// Twitter {{{
const twitter = {
  stallTimer: null,
  expandUrl: (text, entities) => {
    const urls = entities.media ? entities.urls.concat(entities.media) : entities.urls;
    for (const url of urls) {
      text = text.replace(url.url, url.expanded_url);
    }
    return text;
  },
  getLastStatus: (screen_name, callback) => {
    twitter.oauth.get(`https://api.twitter.com/1.1/users/show.json?screen_name=${screen_name}`, config.accessToken, config.accessTokenSecret, (error, data, response) => {
      callback(JSON.parse(data));
    });
  },
  init: () => {
    twitter.oauth = new (require('oauth')).OAuth( 'https://twitter.com/oauth/request_token', 'https://twitter.com/oauth/access_token', config.consumerKey, config.consumerSecret, '1.0A', null, 'HMAC-SHA1');
    twitter.connect();
  },
  reconnectCount: 0,
  reconnect: () => {
    setTimeout(()=>{ twitter.connect(); }, Math.pow(2, twitter.count) * 1000);
    twitter.reconnectCount++;
    ircd.send(null, 'NOTICE', ['#timeline', 'Reconnecting stream']);
  },
  connect: () => {
    const request = twitter.oauth.get('https://userstream.twitter.com/1.1/user.json?replies=all', config.accessToken, config.accessTokenSecret);
    // const request = oauth.get('https://stream.twitter.com/1.1/statuses/sample.json', config.accessToken, config.accessTokenSecret);

    request.on('response', (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (data) => {
        clearTimeout(twitter.stallTimer);
        twitter.stallTimer = setTimeout(() => { twitter.reconnect(); }, 60000);

        buffer += data;
        let lines = buffer.split('\r\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line !== '') {
            const status = JSON.parse(line);
            if (status.text || status.event) {
              eventEmitter.emit('tweet', status);
            } else if (status.friends) {
              // 最初に送られてくるやつ
            } else {
              // delete
            }
          }
        }

      })
    });
    request.on('error', (error) => {
      log(error);
    });
    request.on('end', () => {
      twitter.reconnect();
    });
    request.end();
  },
  toReadable: (status, nick) => {
    let name, text;
    if (status.event) {
      switch (status.event) {
        case 'block':
          name = status.source.screen_name;
          text = '\00310Block =>\017'  + ` ${status.target.screen_name} https://twitter.com/${status.source.screen_name}`;
          break;
        case 'unblock':
          name = status.source.screen_name;
          text = '\00310Unblock =>\017' + ` ${status.target.screen_name} https://twitter.com/${status.source.screen_name}`;
          break;
        case 'favorite':
          name = status.source.screen_name;
          text = '\00310Favorite =>\017' + ` ${status.target.screen_name}: ${twitter.expandUrl(status.target_object.text, status.target_object.entities)}  https://twitter.com/${status.source.screen_name}`;
          break;
        case 'unfavorite':
          name = status.source.screen_name;
          text = '\00310Unfavorite =>\017' + ` ${status.target.screen_name}: ${twitter.expandUrl(status.target_object.text, status.target_object.entities)}  https://twitter.com/${status.source.screen_name}`;
          break;
        case 'follow':
          name = status.source.screen_name;
          text = '\00310Follow =>\017' + ` ${status.target.screen_name} https://twitter.com/${status.source.screen_name}`;
          break;
        case 'unfollow':
          name = status.source.screen_name;
          text = '\00310Unfollow =>\017' + ` ${status.target.screen_name} https://twitter.com/${status.source.screen_name}`;
          break;
        case 'list_member_added':
          name = status.source.screen_name;
          text = '\00310Listd =>\017' + ` ${status.target.screen_name} https://twitter.com/${status.source.screen_name}`;
          break;
        case 'list_member_removed':
          name = status.source.screen_name;
          text = '\00310Unlist =>\017' + ` ${status.target.screen_name} https://twitter.com/${status.source.screen_name}`;
          break;
        case 'list_created':
        case 'list_destroyed':
        case 'list_updated':
        case 'list_user_subscribed':
        case 'list_user_unsubscribed':
        case 'quoted_tweet':
        case 'user_update':
      }
    } else if (status.direct_message) {
      name = status.direct_message.sender.screen_name;
      text = twitter.expandUrl(status.direct_message.text, status.direct_message.entities);
    } else if (status.quoted_status) {
      name = status.user.screen_name;
      text = `${twitter.expandUrl(status.text, status.entities)} ` + '\00310>>\017' + ` @${status.quoted_status.user.screen_name}: ${twitter.expandUrl(status.quoted_status.text, status.quoted_status.entities)}`
    } else if (status.retweeted_status) {
      name = status.user.screen_name;
      text = '\00310\u267a\017' + ` ${status.retweeted_status.user.screen_name}: ${twitter.expandUrl(status.retweeted_status.text, status.retweeted_status.entities)} ` + '\00310[' + `${moment(status.retweeted_status.created_at, 'ddd MMM DD HH:mm:ss Z YYYY').fromNow()}` + ']\017';
    } else if (status.text) {
      name = status.user.screen_name;
      text = twitter.expandUrl(status.text, status.entities);
    }

    text = unescape(text);
    text = text.replace(/[\r\n]/g, ' ');
    return [name, text];
  }
}
twitter.init();
// }}}
