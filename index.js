const config = require('./config');
const util = require('util');
const eventEmitter = new (require('events'))();
const moment = require('moment');
const unescape = require('lodash.unescape');

// IRCD {{{
require('net').createServer((connection) => {
  const send = (prefix, command, params = ['']) => {
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
    util.log(`>> ${msg}`); // DEBUG
    connection.write(`${msg}\r\n`);
  }

  let nick, buffer = '';
  connection.on('data', (data) => {
    buffer += data;
    let lines = buffer.split('\r\n');
    buffer = lines.pop();

    for (const line of lines) {
      const [command, ...args] = line.split(' ');
      util.log('<< ', command, args); //DEBUG
      switch (command) {
        case 'NICK':
          nick = args[0];
          break;
        case 'USER':
          // client incoming
          send(null, '001', [nick, 'Welcome to tig.js']);
          send(`${args[0]}!${args[3]}@${connection.remoteAddress}`, 'JOIN', ['#timeline']);
          send(null, 'MODE', ['#timeline', '+mot', args[0]]);

          twitter.getLastStatus(args[0], (user) => {
            send(null, 'TOPIC', ['#timeline', user.status.text]);
          });

          eventEmitter.on('tweet', function (status) {
            if (status.user.screen_name === nick) { return; }
            if (connection.writable) {
              const [name, text] = twitter.toReadable(status, nick);
              send(name, 'PRIVMSG', ['#timeline', text]);
            } else {
              util.log(this);
              eventEmitter.removeListener('tweet', this._events.tweet);
            }
          });
          break;
        case 'PRIVMSG':
          if (args[0] === '#timeline') {
            const text = args.slice(1).join(' ').replace(/^:/, '');
            twitter.oauth.post('https://api.twitter.com/1.1/statuses/update.json', config.accessToken, config.accessTokenSecret, { status: text }, (r, data, response) => {
              send(null, 'TOPIC', ['#timeline', JSON.parse(data).text]);
            });
          }
          break;
      }
    }
  });
  connection.on('error', (error) => {
    util.log(error);
  });
  connection.on('close', () => {
    // connection close
  });
}).listen(process.env.PORT || 16668);
// }}}


// Twitter {{{
const twitter = {
  expandUrl: (text, entities) => {
    const urls = entities.media ? entities.urls.concat(entities.media) : entities.urls;
    for (const url of urls) {
      text = text.replace(url.url, url.expanded_url);
    }
    return text;
  },
  getLastStatus: (screen_name, callback) => {
    twitter.oauth.get(`https://api.twitter.com/1.1/users/show.json?screen_name=${screen_name}`, config.accessToken, config.accessTokenSecret, (r, data, response) => {
      callback(JSON.parse(data));
    });
  },
  init: () => {
    twitter.oauth = new (require('oauth')).OAuth( 'https://twitter.com/oauth/request_token', 'https://twitter.com/oauth/access_token', config.consumerKey, config.consumerSecret, '1.0A', null, 'HMAC-SHA1');
    twitter.connect();
  },
  restartCount: 0,
  reconnect: () => {
    setTimeout(()=>{ twitter.connect(); }, Math.pow(2, twitter.count) * 1000);
    twitter.restartCount++;
    util.log('restart stream');
  },
  connect: () => {
    const request = twitter.oauth.get('https://userstream.twitter.com/1.1/user.json?replies=all', config.accessToken, config.accessTokenSecret);
    // const request = oauth.get('https://stream.twitter.com/1.1/statuses/sample.json', config.accessToken, config.accessTokenSecret);

    request.on('response', (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (data) => {
        buffer += data;
        let lines = buffer.split('\r\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line !== '') {
            const status = JSON.parse(line);
            if (status.text) {
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
      util.log(error);
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
          name = status.source;
          text = '\00310block\017'  + ` ${status.target} https://twitter.com/${status.source}`;
          break;
        case 'unblock':
          name = status.source;
          text = '\00310unblock\017' + ` ${status.target} https://twitter.com/${status.source}`;
          break;
        case 'favorite':
          if (status.source === nick) {}
          name = status.source;
          text = '\00310favorit\017' + ` ${status.target}: ${status.tartget_object}  https://twitter.com/${status.source}`;
          break;
        case 'unfavorite':
          name = status.source;
          text = '\00310unfavorit\017' + ` ${status.target}: ${status.tartget_object}  https://twitter.com/${status.source}`;
          break;
        case 'follow':
          name = status.source;
          text = '\00310follow\017' + ` ${status.target} https://twitter.com/${status.source}`;
          break;
        case 'unfollow':
          name = status.source;
          text = '\00310unfollow\017' + ` ${status.target} https://twitter.com/${status.source}`;
          break;
        case 'list_member_added':
          name = status.source;
          text = '\00310listd\017' + ` ${status.target} https://twitter.com/${status.source}`;
          break;
        case 'list_member_removed':
          name = status.source;
          text = '\00310unlist\017' + ` ${status.target} https://twitter.com/${status.source}`;
          break;
        case 'list_created':
        case 'list_destroyed':
        case 'list_updated':
        case 'list_user_subscribed':
        case 'list_user_unsubscribed':
        case 'quoted_tweet':
        case 'user_update':
      }
    }

    if (status.direct_message) {
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
